import * as ExecutionBackend from "../../execution/contract/execution-service"
import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as Turn from "../../thread/model/turn-record"
import * as TurnRepository from "../../thread/repository/turn-repository"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import { Input } from "../contract/product-operation"
import { OperationUnavailable } from "../contract/product-operation-service"
import { OperationError } from "../operation-error"
import { Cause, Clock, Console, Deferred, Effect, Fiber } from "effect"

export interface Dependencies {
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity: number
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly resolveExecutionRoute: (mode: string, tuning?: undefined, workspace?: string) => Effect.Effect<Turn.ExecutionRoutePin, unknown, never>
  readonly createObservedSubmission: (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) => Effect.Effect<{ readonly turn: Turn.Turn; readonly claimed: boolean }, unknown, never>
  readonly ensureTurnSummary: (turn: Turn.Turn) => Effect.Effect<void, unknown, never>
  readonly setTurnStatus: (id: Turn.TurnId, status: Turn.Status, cursor: string | undefined, now: number) => Effect.Effect<Turn.Turn, unknown, never>
  readonly publishInteractiveActivity: (origin: number, event: import("../interactive/interactive-event").InteractiveEvent) => void
  readonly rootTurnOwner: import("../../thread/queue/root-turn-owner").Interface
  readonly executionIngest: import("../../execution/ingest/execution-ingest-service").Interface
  readonly prepareExecution: (turn: Turn.AgentExecutionTurn, workspace: string, persist?: boolean) => Effect.Effect<{ readonly prompt: string; readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined; readonly extensionPin: Turn.ExecutionExtensionPin | undefined }, unknown, never>
  readonly claimQueuedTurn: (threadId: Thread.ThreadId, now: number) => Effect.Effect<TurnRepository.QueueClaim | undefined, unknown, never>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<unknown, never, never>
  readonly queueMutationEvent: (queue: TurnRepository.QueueItemChange) => import("../interactive/interactive-event").InteractiveEvent
  readonly deliverResultEvents: (turnId: Turn.TurnId, events: ReadonlyArray<ExecutionBackend.Event>, delivered?: ReadonlySet<string>) => void
  readonly projectExecutionResult: (threadId: Thread.ThreadId, result: ExecutionBackend.Result) => Effect.Effect<void, unknown, never>
  readonly ensureIngest: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<void, unknown, never>
  readonly awaitIngestSettled: (turnId: Turn.TurnId) => Effect.Effect<void, unknown, never>
  readonly executionDependencies: import("effect").Context.Context<
    | ThreadRepository.Service
    | TurnRepository.Service
    | ExecutionBackend.Service
    | import("../../thread/repository/thread-summary-repository").Service
    | import("../../thread/repository/transcript-repository").Service
    | import("../../thread/repository/usage-repository").Service
    | import("../../context/context-resolution-service").Service
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  >
  readonly followClaimed: ((turnId: Turn.TurnId) => Effect.Effect<void, unknown, never>) | undefined
  readonly staleQueuedTurnsError: typeof staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
  readonly awaitSessionQuiescence: (backend: ExecutionBackend.Interface, threadId: Thread.ThreadId) => Effect.Effect<Turn.AgentExecutionTurn | undefined, unknown, never>
  readonly operationError: (message: string) => Effect.Effect<never, OperationError>
  readonly unavailable: (input: Input, message: string) => OperationUnavailable
}

export const run = Effect.fn("NoninteractiveOperation.run")(function* (input: Extract<Input, { readonly _tag: "Run" }>, dependencies: Dependencies) {

  const program = Effect.gen(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const backend = yield* ExecutionBackend.Service
    const now = yield* Clock.currentTimeMillis
    const thread =
      input.threadId === undefined
        ? yield* threads.create({
            id: yield* dependencies.makeThreadId,
            workspace: input.workspace ?? dependencies.defaultWorkspace,
            title: clampThreadTitle(input.prompt.join(" ")) || "New thread",
            now,
          })
        : yield* threads
            .get(Thread.ThreadId.make(input.threadId))
            .pipe(
              Effect.flatMap((existingThread) =>
                existingThread === undefined
                  ? dependencies.operationError(`Thread ${input.threadId} does not exist`)
                  : Effect.succeed(existingThread),
              ),
            )
    const runTurn = Effect.fn("ProductOperation.runTurn")(function* (
      turn: Turn.AgentExecutionTurn,
      preparedInput?: {
        readonly prompt: string
        readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
        readonly extensionPin: Turn.ExecutionExtensionPin | undefined
      },
    ) {
      const blockedTurn = yield* dependencies.awaitSessionQuiescence(backend, turn.threadId)
      if (blockedTurn !== undefined)
        return yield* dependencies.operationError(
          `Cancelled turn ${blockedTurn.id} is still releasing its execution; try again shortly`,
        )
      const startedAt = yield* Clock.currentTimeMillis
      const deliveredCursors = new Set<string>()
      let directDelivery = true
      let receivedDirectEvent = false
      yield* Effect.logInfo("turn.started").pipe(
        Effect.annotateLogs({
          "rika.thread.id": String(thread.id),
          "rika.turn.id": String(turn.id),
        }),
      )
      const execution = yield* Effect.gen(function* () {
        const prepared = preparedInput ?? (yield* dependencies.prepareExecution(turn, thread.workspace))
        const runningTurn = yield* dependencies.setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
        dependencies.publishInteractiveActivity(0, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: thread.id,
          turn: runningTurn,
        })
        yield* dependencies.ensureIngest(turn.threadId, turn.id)
        const startCompleted = yield* Deferred.make<void>()
        const started = yield* Effect.forkChild(
          dependencies.rootTurnOwner
            .start({
              threadId: turn.threadId,
              turnId: turn.id,
              prompt: prepared.prompt,
              executionRoute: turn.executionRoute,
              onEvent: (event) => {
                if (!directDelivery) return
                receivedDirectEvent = true
                deliveredCursors.add(event.cursor)
                dependencies.executionIngest.deliver(turn.id, event)
              },
              ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
              ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
            })
            .pipe(Effect.ensuring(Deferred.succeed(startCompleted, undefined))),
        )
        let followed = false
        while (true) {
          if (receivedDirectEvent || (yield* Deferred.isDone(startCompleted))) break
          if ((yield* backend.inspect(turn.id)) !== undefined) {
            for (let attempts = 0; attempts < 100; attempts += 1) {
              if (receivedDirectEvent) break
              yield* Effect.yieldNow
            }
            if (!receivedDirectEvent && !(yield* Deferred.isDone(startCompleted))) directDelivery = false
            break
          }
          yield* Effect.yieldNow
        }
        if (!directDelivery && dependencies.followClaimed !== undefined)
          while (!(yield* Deferred.isDone(startCompleted))) {
            const outcome = yield* Effect.exit(dependencies.followClaimed(turn.id))
            if (outcome._tag === "Success") {
              followed = true
              break
            }
            yield* Effect.sleep("10 millis")
          }
        return { result: yield* Fiber.join(started), followed }
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failedAt = yield* Clock.currentTimeMillis
            yield* Effect.logError("turn.failed").pipe(
              Effect.annotateLogs({
                "rika.duration.ms": failedAt - startedAt,
                "rika.failure.kind": error instanceof Error ? error.name : typeof error,
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
              }),
            )
            yield* dependencies.setTurnStatus(turn.id, "failed", turn.lastCursor, failedAt)
            return yield* Effect.failCause(Cause.fail(error))
          }),
        ),
      )
      const { result, followed } = execution
      const completedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("turn.finished").pipe(
        Effect.annotateLogs({
          "rika.duration.ms": completedAt - startedAt,
          "rika.thread.id": String(thread.id),
          "rika.turn.id": String(turn.id),
          "rika.turn.status": result.status,
        }),
      )
      if (!followed) {
        dependencies.deliverResultEvents(turn.id, result.events, directDelivery ? deliveredCursors : new Set<string>())
        const updated = yield* dependencies.setTurnStatus(
          turn.id,
          result.status,
          result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
          completedAt,
        )
        yield* dependencies.projectExecutionResult(thread.id, result)
        yield* dependencies.ensureIngest(updated.threadId, updated.id)
        yield* dependencies.awaitIngestSettled(updated.id)
      }
      return result
    })
    const drainRunQueue = Effect.fn("ProductOperation.drainRunQueue")(function* () {
      while (true) {
        const queue = yield* turns.readQueue(thread.id)
        if (queue.queuedCount === 0) return
        const staleError = dependencies.staleQueuedTurnsError(
          thread.id,
          queue.turns,
          yield* Clock.currentTimeMillis,
          dependencies.queuedTurnPromoteMaxAgeMs,
        )
        if (staleError !== undefined) return yield* staleError
        if ((yield* dependencies.awaitSessionQuiescence(backend, thread.id)) !== undefined) return
        const promoted = yield* dependencies.claimQueuedTurn(thread.id, yield* Clock.currentTimeMillis)
        if (promoted === undefined) return
        const prepared = yield* dependencies.prepareExecution(promoted.turn, thread.workspace, false).pipe(
          Effect.map((value) => ({ _tag: "Success" as const, value })),
          Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
          Effect.onInterrupt(() =>
            turns.releaseQueuedClaim(promoted).pipe(Effect.andThen(dependencies.releaseTurnObserver(promoted.turn.id))),
          ),
        )
        if (prepared._tag === "Failure") {
          const transition = yield* turns.finishQueuedClaim(
            promoted,
            "failed",
            promoted.turn.lastCursor,
            promoted.turn.extensionPin,
            yield* Clock.currentTimeMillis,
          )
          if (transition._tag === "Transitioned") {
            dependencies.publishInteractiveActivity(0, dependencies.queueMutationEvent(transition.queue))
          }
          yield* dependencies.releaseTurnObserver(promoted.turn.id)
          continue
        }
        const transition = yield* turns.finishQueuedClaim(
          promoted,
          "running",
          promoted.turn.lastCursor,
          prepared.value.extensionPin,
          yield* Clock.currentTimeMillis,
        )
        if (transition._tag === "Unavailable") {
          yield* dependencies.releaseTurnObserver(promoted.turn.id)
          continue
        }
        dependencies.publishInteractiveActivity(0, dependencies.queueMutationEvent(transition.queue))
        yield* runTurn(transition.turn, prepared.value).pipe(
          Effect.ensuring(dependencies.releaseTurnObserver(transition.turn.id)),
        )
      }
    })
    yield* drainRunQueue()
    const turnId = yield* dependencies.makeTurnId
    const prompt = input.prompt.join(" ")
    const observed = yield* dependencies.createObservedSubmission(turns, {
      id: turnId,
      threadId: thread.id,
      prompt,
      executionRoute: yield* dependencies.resolveExecutionRoute(input.mode ?? "medium", undefined, thread.workspace),
      queueCapacity: dependencies.pendingTurnCapacity,
      now,
    })
    const submitted = observed.turn
    yield* dependencies.ensureTurnSummary(submitted)
    yield* Effect.logInfo("turn.accepted").pipe(
      Effect.annotateLogs({
        "rika.thread.id": String(thread.id),
        "rika.turn.id": String(submitted.id),
        "rika.turn.status": submitted.status,
      }),
    )
    if (submitted.status === "queued") return
    if (!observed.claimed)
      return yield* dependencies.operationError(`Turn ${submitted.id} already has an execution observer`)
    if (!Turn.isAgentExecution(submitted))
      return yield* dependencies.operationError(`Turn ${submitted.id} is not an executable turn`)
    const result = yield* runTurn(submitted).pipe(Effect.ensuring(dependencies.releaseTurnObserver(submitted.id)))
    yield* drainRunQueue()
    if (input.streamJson) {
      yield* Effect.forEach(result.events, (event) => Console.log(JSON.stringify(event)), { discard: true })
      return
    }
    const text = result.events
      .filter((event) => event.type === "model.output.completed")
      .map((event) => event.text ?? "")
      .join("")
    if (text.length > 0) yield* Console.log(text)
    if (result.status === "cancelled")
      return yield* dependencies.operationError(`Turn ${submitted.id} was cancelled before it completed`)
    if (result.status === "failed") {
      const failure = result.events.findLast((event) => event.type === "execution.failed")?.text
      return yield* dependencies.operationError(
        failure === undefined ? `Turn ${submitted.id} failed` : `Turn ${submitted.id} failed: ${failure}`,
      )
    }
    if (result.status === "completed" && text.length === 0)
      return yield* dependencies.operationError(`Turn ${submitted.id} completed without output`)
  })
  yield* program.pipe(
    Effect.provide(dependencies.executionDependencies),
    Effect.scoped,
    Effect.mapError((error) => dependencies.unavailable(input, String(error))),
  )
})
