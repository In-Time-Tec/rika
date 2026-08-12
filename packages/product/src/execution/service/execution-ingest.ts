import { Cause, Clock, Deferred, Duration, Effect, Fiber, PubSub, Scope, Stream } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionAuthorityReconciliation from "../lifecycle/execution-authority-reconciliation"
import * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import * as LiveThreadProjection from "../../thread/projection/live-thread-projection"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnQueuePromotion from "../../thread/repository/turn-repository-queue"
import {
  isReviewRouteMode,
  makeFailure,
  operationError,
  reviewIntent,
  shouldRetryTurn,
  turnFailure,
  turnRetryBudget,
  turnRetryDelay,
} from "./execution-ingest-policy"
import type { InteractiveEvent } from "../../operation/interactive/interactive-runtime-event"

export interface CommittedChange {
  readonly threadId: Thread.ThreadId
  readonly turnId: Turn.TurnId
  readonly change: ExecutionProjection.Change
}

export interface ResolvedSubmission {
  readonly turnId: Turn.TurnId
  readonly threadId: Thread.ThreadId
}

export interface SubmissionRegistry {
  readonly register: (submissionId: string, turnId: Turn.TurnId, threadId: Thread.ThreadId) => void
  readonly resolve: (submissionId: string) => ResolvedSubmission | undefined
}

const submissionRegistryCapacity = 1_024

export const makeSubmissionRegistry = (): SubmissionRegistry => {
  const submissions = new Map<string, ResolvedSubmission>()
  return {
    register: (submissionId, turnId, threadId) => {
      submissions.delete(submissionId)
      submissions.set(submissionId, { turnId, threadId })
      while (submissions.size > submissionRegistryCapacity) {
        const oldest = submissions.keys().next().value
        if (oldest === undefined) break
        submissions.delete(oldest)
      }
    },
    resolve: (submissionId) => submissions.get(submissionId),
  }
}

export interface ExecutionIngestInput {
  readonly turns: TurnRepository.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly rootTurnOwner: RootTurnOwner.Interface
  readonly hub: LiveThreadProjection.Interface
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<Turn.TurnId>
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly prepareExecution: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
    persist?: boolean,
  ) => Effect.Effect<
    import("../../operation/interactive/interactive-session-runtime").PreparedTurn,
    Error,
    import("../../operation/interactive/interactive-session-runtime").InteractiveExecutionContextServices
  >
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    Turn.Turn,
    Error,
    import("@rika/product/thread-summary-repository").Service | TurnRepository.Service
  >
  readonly ensureTurnSummary: (
    turn: Turn.Turn,
  ) => Effect.Effect<void, Error, import("@rika/product/thread-summary-repository").Service>
  readonly notifyThreadSummaries: Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly pendingTurnCapacity: number
  readonly queueMutationEvent: (change: TurnQueuePromotion.QueueItemChange) => InteractiveEvent
  readonly staleQueuedTurnsError: (
    threadId: Thread.ThreadId,
    queue: ReadonlyArray<Turn.AgentExecutionTurn>,
    now: number,
    maxAgeMs: number,
  ) => Error | undefined
  readonly queuedTurnPromoteMaxAgeMs: number
  readonly temporaryThreadTitle: (prompt: string) => string
  readonly executionDependencies: import("../../operation/interactive/interactive-session-runtime").InteractiveExecutionContext
}

export interface ExecutionIngest {
  readonly supervise: Effect.Effect<void>
  readonly watchAdmitted: (turnId: Turn.TurnId) => Effect.Effect<void, never, Scope.Scope>
  readonly awaitSettled: (turnId: Turn.TurnId) => Effect.Effect<
    {
      readonly finalTurnId: Turn.TurnId
      readonly changes: ReadonlyArray<ExecutionProjection.Change>
      readonly failure?: string
    },
    never,
    Scope.Scope
  >
  readonly commits: PubSub.PubSub<CommittedChange>
  readonly quiesceThread: (threadId: Thread.ThreadId) => Effect.Effect<void>
  readonly stop: Effect.Effect<void>
}

const rearmDelay = (attempt: number) =>
  Duration.min(Duration.millis(100 * 2 ** Math.min(Math.max(0, attempt - 1), 3)), Duration.seconds(1))

const isAgentExecution = (turn: Turn.Turn | undefined): turn is Turn.AgentExecutionTurn =>
  turn !== undefined && ThreadResult.TurnResult.isAgentExecution(turn)

export const make = Effect.fn("ExecutionIngest.make")(function* (input: ExecutionIngestInput) {
  const {
    turns,
    transcripts,
    backend,
    rootTurnOwner,
    hub,
    turnChanges,
    dirtyTurnObservers,
    publishInteractiveActivity,
    prepareExecution,
    setTurnStatus,
    ensureTurnSummary,
    notifyThreadSummaries,
    makeTurnId,
    pendingTurnCapacity,
    queueMutationEvent,
    staleQueuedTurnsError,
    queuedTurnPromoteMaxAgeMs,
    temporaryThreadTitle,
    executionDependencies,
  } = input
  const watching = new Set<string>()
  const fibers = new Map<string, Fiber.Fiber<void, never>>()
  const collectedChanges = new Set<string>()
  const changesByTurn = new Map<string, Array<ExecutionProjection.Change>>()
  const settlementFailures = new Map<string, string>()
  const settled = new Map<string, Deferred.Deferred<Turn.TurnId>>()
  const retriedFrom = new Map<string, string>()
  const commits = yield* PubSub.sliding<CommittedChange>(128)
  const settledFor = Effect.fn("ExecutionIngest.settledFor")(function* (turnId: Turn.TurnId) {
    const key = String(turnId)
    const existing = settled.get(key)
    if (existing !== undefined) return existing
    const deferred = yield* Deferred.make<Turn.TurnId>()
    settled.set(key, deferred)
    return deferred
  })
  const settleChain = Effect.fn("ExecutionIngest.settleChain")(function* (finalTurnId: Turn.TurnId) {
    const complete = (id: Turn.TurnId) =>
      settledFor(id).pipe(
        Effect.flatMap((deferred) => Deferred.succeed(deferred, finalTurnId)),
        Effect.ignore,
      )
    yield* complete(finalTurnId)
    let source = retriedFrom.get(String(finalTurnId))
    while (source !== undefined) {
      yield* complete(Turn.TurnId.make(source))
      source = retriedFrom.get(source)
    }
  })
  const threadForTurn = (turn: Turn.Turn) =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const thread = yield* threads.get(turn.threadId)
      if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
      return thread
    })
  const settledSetTurnStatus = (id: Turn.TurnId, status: ExecutionStatus.Status, now: number) =>
    setTurnStatus(id, status, now).pipe(
      Effect.mapError((error) => operationError(String(error), error)),
      Effect.map((turn) => turn as Turn.AgentExecutionTurn),
    )
  const drainThread = Effect.fn("ExecutionIngest.drainThread")(function* (threadId: Thread.ThreadId) {
    const queue = yield* turns.readQueue(threadId)
    if (queue.queuedCount === 0) return
    const staleError = staleQueuedTurnsError(
      threadId,
      queue.turns,
      yield* Clock.currentTimeMillis,
      queuedTurnPromoteMaxAgeMs,
    )
    if (staleError !== undefined) {
      publishInteractiveActivity(0, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        threadId,
        failure: makeFailure(staleError),
      })
      return
    }
    const claim = yield* rootTurnOwner.claimQueued(threadId, yield* Clock.currentTimeMillis)
    if (claim === undefined) return
    const transition = yield* turns.finishQueuedClaim(claim, "running", yield* Clock.currentTimeMillis)
    if (transition._tag === "Unavailable") return
    publishInteractiveActivity(0, queueMutationEvent(transition.queue))
    yield* notifyThreadSummaries
    yield* launchTurn(transition.turn, 1, true)
  })
  const resultAfterWatch = Effect.fn("ExecutionIngest.resultAfterWatch")(function* (
    turn: Turn.AgentExecutionTurn,
    latestChange: ExecutionProjection.Change | undefined,
  ) {
    const stored = yield* transcripts.get(turn.id)
    const checkpoint =
      latestChange?._tag === "ProjectionPatch"
        ? latestChange.checkpoint
        : (latestChange?.checkpoint ?? stored?.projectorCheckpoint)
    const fallbackStatus =
      turn.status === "completed" ||
      turn.status === "failed" ||
      turn.status === "cancelled" ||
      turn.status === "waiting" ||
      turn.status === "cancelling"
        ? turn.status
        : "running"
    const state = latestChange?.state ??
      stored?.state ??
      (yield* Effect.option(backend.inspectTurn(turn.executionLink!)).pipe(
        Effect.map((inspection) =>
          inspection._tag === "Some" &&
          inspection.value.status !== "unavailable" &&
          inspection.value.status !== "accepted" &&
          inspection.value.status !== "queued"
            ? {
                status: inspection.value.status,
                usage: ExecutionProjection.emptyUsageState(),
                steering: { steeringMessages: 0, followUpMessages: 0 },
              }
            : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      )) ?? {
        status: fallbackStatus,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      }
    return {
      turnId: String(turn.id),
      status: state.status,
      state,
      units: stored?.units ?? [],
      ...(checkpoint === undefined ? {} : { checkpoint }),
    }
  })
  const watchOne = Effect.fn("ExecutionIngest.watchOne")(function* (turn: Turn.AgentExecutionTurn) {
    const clock = yield* Clock.Clock
    const thread = yield* threadForTurn(turn)
    const prepared = yield* prepareExecution(turn, thread.workspace, false)
    if (prepared.messages.length > 0)
      publishInteractiveActivity(0, {
        _tag: "ContextDiagnostics",
        selectionEpoch: 0,
        threadId: thread.id,
        turnId: turn.id,
        messages: prepared.messages,
      })
    const startedAt = clock.currentTimeMillisUnsafe()
    const running = yield* settledSetTurnStatus(turn.id, "running", startedAt)
    if (running.status !== "running") return "skipped" as const
    const titleIntent =
      (yield* turns.list(thread.id)).length === 1 && thread.title === temporaryThreadTitle(turn.prompt)
        ? ({ _tag: "GenerateThreadTitle", expectedTitle: thread.title } as const)
        : undefined
    if (turn.executionLink === undefined) {
      const started = yield* Effect.exit(
        rootTurnOwner.startTurn({
          threadId: turn.threadId,
          turnId: turn.id,
          workspace: thread.workspace,
          prompt: prepared.prompt,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          executionRoute: turn.executionRoute,
          ...(titleIntent === undefined ? {} : { titleIntent }),
          ...(isReviewRouteMode(turn.executionRoute.mode) ? { reviewIntent: reviewIntent(turn.prompt) } : {}),
        }),
      )
      if (started._tag === "Failure") {
        // An admission failure is terminal for the turn, unlike a watch failure which re-arms.
        settlementFailures.set(String(turn.id), String(Cause.squash(started.cause)))
        yield* settledSetTurnStatus(turn.id, "failed", yield* Clock.currentTimeMillis)
        return "start-failed" as const
      }
    }
    const current = yield* turns.get(turn.id)
    if (!isAgentExecution(current) || current.executionLink === undefined)
      return yield* operationError(`Turn ${turn.id} has no persisted execution link`)
    const executionLink = current.executionLink
    publishInteractiveActivity(0, {
      _tag: "TurnStarted",
      selectionEpoch: 0,
      activitySequence: 0,
      threadId: thread.id,
      turn: current,
    })
    yield* notifyThreadSummaries
    const projection = yield* transcripts.get(turn.id)
    let latestChange: ExecutionProjection.Change | undefined
    yield* backend
      .watchTurn(executionLink, {
        prompt: current.prompt,
        ...(projection === undefined ? {} : { units: projection.units }),
        ...(projection?.projectorCheckpoint === undefined ? {} : { checkpoint: projection.projectorCheckpoint }),
      })
      .pipe(
        Stream.runForEach((event) =>
          event._tag === "ModelPreviewed" || event._tag === "ModelPreviewCleared"
            ? Effect.sync(() =>
                event._tag === "ModelPreviewed"
                  ? hub.preview(thread.id, current.id, event)
                  : hub.clearPreview(thread.id, current.id, event),
              )
            : Effect.gen(function* () {
                const committed = yield* transcripts.commitProjection(current, event)
                if (committed === "stale")
                  return yield* TranscriptRepository.RepositoryError.make({
                    message: `Turn ${current.id} projection revision is stale`,
                  })
                latestChange = event
                PubSub.publishUnsafe(commits, { threadId: thread.id, turnId: current.id, change: event })
                hub.commitChange(thread.id, current, event)
                if (collectedChanges.has(String(current.id))) {
                  const collected = changesByTurn.get(String(current.id)) ?? []
                  if (collected.length < 10_000) collected.push(event)
                  changesByTurn.set(String(current.id), collected)
                }
              }),
        ),
      )
    return yield* resultAfterWatch(current, latestChange)
  })
  const watchClaimed = (
    turn: Turn.AgentExecutionTurn,
    attempt: number,
  ): Effect.Effect<
    "settled" | "rearm" | "skipped",
    never,
    import("../../operation/interactive/interactive-session-runtime").InteractiveExecutionContextServices | Scope.Scope
  > =>
    Effect.gen(function* () {
      const key = String(turn.id)
      if (watching.has(key)) return "skipped"
      watching.add(key)
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const result = yield* watchOne(turn)
          if (result === "skipped") return "skipped" as const
          if (result === "start-failed") {
            yield* drainThread(turn.threadId)
            yield* settleChain(turn.id)
            return "settled" as const
          }
          yield* settledSetTurnStatus(turn.id, result.status, yield* Clock.currentTimeMillis)
          if (
            ExecutionStatus.isTerminalStatus(result.status) ||
            result.status === "waiting" ||
            result.status === "cancelling"
          ) {
            if (result.status === "failed") {
              const failure = turnFailure(result.units)
              const retryable = failure?.retryable ?? false
              if (shouldRetryTurn({ retryable, retry: retryable ? "automatic" : "none", attempt })) {
                const created = yield* turns.createForSubmission({
                  id: yield* makeTurnId,
                  threadId: turn.threadId,
                  prompt: turn.prompt,
                  ...(turn.promptParts === undefined ? {} : { promptParts: turn.promptParts }),
                  executionRoute: turn.executionRoute,
                  lineage: { _tag: "Retried", sourceTurnId: turn.id },
                  queueCapacity: pendingTurnCapacity,
                  now: yield* Clock.currentTimeMillis,
                })
                const retryTurn = created
                if (retryTurn.status !== "queued") {
                  const claimed = yield* rootTurnOwner.claim(retryTurn.id, retryTurn.status)
                  if (claimed) {
                    retriedFrom.set(String(retryTurn.id), String(turn.id))
                    publishInteractiveActivity(0, {
                      _tag: "TurnRetryScheduled",
                      selectionEpoch: 0,
                      threadId: turn.threadId,
                      turnId: turn.id,
                      retryTurnId: retryTurn.id,
                      attempt,
                      budget: turnRetryBudget,
                      message: failure?.message ?? "Execution failed",
                      nextAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(turnRetryDelay({ attempt })),
                    })
                    yield* Effect.sleep(turnRetryDelay({ attempt }))
                    yield* ensureTurnSummary(retryTurn).pipe(Effect.ignore)
                    yield* launchTurn(retryTurn, attempt + 1, true)
                    return "settled" as const
                  }
                }
              }
              publishInteractiveActivity(0, {
                _tag: "ExecutionFailed",
                selectionEpoch: 0,
                threadId: turn.threadId,
                turnId: turn.id,
                failure: makeFailure(failure?.message ?? `Execution ${result.status}`),
              })
            }
            yield* drainThread(turn.threadId)
            yield* settleChain(turn.id)
            return "settled" as const
          }
          // The stream ended before the turn reached a terminal status. Release the claim and ask
          // for a re-watch so a later scan resumes the run from its last committed checkpoint.
          yield* Effect.sync(() => dirtyTurnObservers.add(turn.id)).pipe(
            Effect.andThen(PubSub.publish(turnChanges, undefined)),
          )
          yield* settleChain(turn.id)
          return "settled" as const
        }),
      )
      watching.delete(key)
      if (outcome._tag === "Failure") {
        yield* Effect.logError("execution-ingest.watch.failed").pipe(
          Effect.annotateLogs({
            "rika.turn.id": String(turn.id),
            "rika.thread.id": String(turn.threadId),
            "rika.failure.kind": String(outcome.cause),
          }),
        )
        return "rearm" as const
      }
      return outcome.value
    })
  const launchTurn = (
    turn: Turn.AgentExecutionTurn,
    attempt: number,
    alreadyClaimed = false,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const key = String(turn.id)
      if (watching.has(key) || fibers.has(key)) return
      if (!alreadyClaimed) {
        const claimed = yield* rootTurnOwner.claim(turn.id, turn.status).pipe(Effect.orElseSucceed(() => false))
        if (!claimed) return
      }
      let fiber: Fiber.Fiber<void, never>
      const run = Effect.gen(function* () {
        const decision = yield* watchClaimed(turn, attempt)
        if (decision === "rearm") {
          // The claim is released before the re-arm so the new watch can re-claim it; the
          // failed watch must never bump the hub generation.
          yield* rootTurnOwner.release(turn.id).pipe(Effect.ignore)
          yield* Effect.sync(() => {
            if (fibers.get(key) === fiber) fibers.delete(key)
          })
          yield* Effect.sleep(rearmDelay(attempt))
          const current = yield* turns.get(turn.id).pipe(Effect.orElseSucceed(() => undefined))
          if (
            isAgentExecution(current) &&
            !ExecutionStatus.isTerminalStatus(current.status) &&
            current.status !== "queued"
          )
            yield* launchTurn(current, attempt)
        }
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.catchCause((cause) =>
          Effect.logError("execution-ingest.launch.failed").pipe(
            Effect.annotateLogs({
              "rika.turn.id": String(turn.id),
              "rika.failure.kind": String(cause),
            }),
          ),
        ),
        Effect.ensuring(rootTurnOwner.release(turn.id).pipe(Effect.ignore)),
      )
      fiber = yield* Effect.forkChild(run)
      fibers.set(key, fiber)
      yield* Fiber.join(fiber).pipe(
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => {
            if (fibers.get(key) === fiber) fibers.delete(key)
          }),
        ),
      )
    })
  const recover = Effect.gen(function* () {
    yield* rootTurnOwner.recoverExecutionAdmissions
    const reconciled = yield* ExecutionAuthorityReconciliation.make({
      turns,
      transcripts,
      backend,
      setTurnStatus: settledSetTurnStatus as unknown as ExecutionAuthorityReconciliation.Input["setTurnStatus"],
    }).pipe(Effect.mapError((error) => operationError(String(error), error)))
    for (const turn of reconciled.active) yield* launchTurn(turn, 1)
  })
  const scanDirty = Effect.gen(function* () {
    const dirty = [...dirtyTurnObservers]
    dirtyTurnObservers.clear()
    for (const turnId of dirty) {
      const turn = yield* turns.get(turnId)
      if (turn === undefined) continue
      if (!isAgentExecution(turn)) continue
      if (ExecutionStatus.isTerminalStatus(turn.status) || turn.status === "queued") {
        yield* drainThread(turn.threadId)
        continue
      }
      yield* launchTurn(turn, 1)
    }
  })
  const supervise = Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.subscribe(turnChanges)
      yield* recover.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("execution-ingest.recover.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", String(cause)),
          ),
        ),
      )
      while (true) {
        yield* PubSub.take(changes)
        yield* scanDirty.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("execution-ingest.scan.failed").pipe(
              Effect.annotateLogs("rika.failure.kind", String(cause)),
            ),
          ),
        )
      }
    }),
  ).pipe(Effect.provide(executionDependencies))
  const quiesceThread = (threadId: Thread.ThreadId): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const threadTurns = yield* turns.list(threadId).pipe(Effect.orElseSucceed(() => []))
      const keys = new Set(threadTurns.map((turn) => String(turn.id)))
      const owned = [...fibers].flatMap(([key, fiber]) => (keys.has(key) ? [fiber] : []))
      yield* Effect.forEach(owned, Fiber.interrupt, { concurrency: "unbounded", discard: true })
      hub.reset(threadId)
    })
  const stop: Effect.Effect<void, never, never> = Effect.forEach([...fibers.values()], Fiber.interrupt, {
    concurrency: "unbounded",
    discard: true,
  })
  const watchAdmitted = (turnId: Turn.TurnId): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const turn = yield* turns.get(turnId).pipe(Effect.orElseSucceed(() => undefined))
      if (!isAgentExecution(turn)) return
      if (ExecutionStatus.isTerminalStatus(turn.status) || turn.status === "queued") {
        yield* drainThread(turn.threadId).pipe(Effect.ignoreCause)
        return
      }
      yield* launchTurn(turn, 1)
    }).pipe(Effect.provide(executionDependencies))
  return {
    supervise,
    watchAdmitted,
    commits,
    awaitSettled: (turnId: Turn.TurnId) =>
      Effect.gen(function* () {
        collectedChanges.add(String(turnId))
        const deferred = yield* settledFor(turnId)
        // Start the watch if it has not started yet so the caller cannot race the commit.
        yield* watchAdmitted(turnId)
        const finalTurnId = yield* Deferred.await(deferred)
        const changes = changesByTurn.get(String(finalTurnId)) ?? []
        changesByTurn.delete(String(finalTurnId))
        collectedChanges.delete(String(finalTurnId))
        const failure = settlementFailures.get(String(finalTurnId))
        settlementFailures.delete(String(finalTurnId))
        return { finalTurnId, changes, ...(failure === undefined ? {} : { failure }) }
      }),
    quiesceThread,
    stop,
  }
})
