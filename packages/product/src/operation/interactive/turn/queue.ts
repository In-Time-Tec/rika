import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as ResolvedContext from "../../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnQueuePromotion from "../../../thread/repository/turn-repository-queue"
import type * as RootTurnOwner from "../../../thread/queue/root-turn-owner"
import { OperationError, operationError, operationFailureDetail } from "../../operation-error"
import { Context, Effect, Ref, Clock, Duration } from "effect"
import { type QueueItem, type InteractiveEvent } from "../session-event"
import { type InteractiveRuntimeContext, type PreparedTurn } from "../session"
import { isReviewRouteMode, reviewIntent } from "../../review/review-policy"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../../thread/queue/pending-turn-policy"
import { turnFailure } from "../../failure-message"
import { makeFailure } from "../../operation-failure"
import { shouldRetryTurn, turnRetryBudget, turnRetryDelay } from "../../turn-retry-policy"

export const queueItem = (turn: Turn.AgentExecutionTurn): QueueItem => {
  const attachments = turn.promptParts
    ?.filter((part) => part.type === "image")
    .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
  const base = {
    id: turn.id,
    prompt: turn.prompt,
    createdAt: turn.createdAt,
  }
  return attachments === undefined || attachments.length === 0 ? base : { ...base, attachments }
}

export type InteractiveQueueInput = Pick<
  InteractiveRuntimeContext,
  | "options"
  | "pendingTurnCapacity"
  | "rootTurnOwner"
  | "prepareExecution"
  | "notifyThreadSummaries"
  | "notifyTurnChanged"
  | "setTurnStatus"
  | "claimQueuedTurn"
  | "emit"
  | "releaseTurnObserver"
  | "executionStartFailureMessage"
  | "queueMutationEvent"
  | "dependencyContext"
  | "executionDependencies"
  | "acquiredBackend"
  | "interactiveThread"
>

export const makeInteractiveQueue = (input: InteractiveQueueInput) => {
  const {
    pendingTurnCapacity,
    rootTurnOwner,
    prepareExecution,
    notifyThreadSummaries,
    notifyTurnChanged,
    setTurnStatus,
    claimQueuedTurn,
    emit,
    releaseTurnObserver,
    executionStartFailureMessage,
    dependencyContext,
    acquiredBackend,
  } = input
  const readQueue = Effect.fn("ProductOperation.interactive.readQueue")(function* (
    threadId: Thread.ThreadId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = Context.get(dependencyContext, TurnRepository.Service)
    const queue = yield* turns.readQueue(threadId)
    dispatch({
      _tag: "QueueUpdated",
      selectionEpoch: 0,
      threadId,
      revision: queue.revision,
      queuedCount: queue.queuedCount,
      change: { _tag: "Reset", items: queue.turns.map(queueItem) },
    })
  })
  const drainQueued = (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ): Effect.Effect<
    number,
    | OperationError
    | TurnRepository.QueueFull
    | ExecutionGateway.StartTurnFailure
    | ExecutionGateway.WatchTurnFailure
    | TurnRepository.RepositoryError
    | import("@rika/product/transcript-repository").RepositoryError,
    | ResolvedContext.Service
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  > =>
    Effect.gen(function* () {
      const turns = Context.get(dependencyContext, TurnRepository.Service)
      return yield* promotePendingTurns({
        thread,
        dispatch,
        turns,
        backend: acquiredBackend,
        pendingCapacity: pendingTurnCapacity,
        prepareExecution: (turn, workspace, persist) =>
          prepareExecution(turn, workspace, persist).pipe(
            Effect.provide(input.executionDependencies),
            Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
          ),
        owner: rootTurnOwner,
        notifyThreadSummaries: notifyThreadSummaries.pipe(
          Effect.provide(input.executionDependencies),
          Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
        ),
        notifyTurnChanged,
        setTurnStatus: (id, status, now) =>
          setTurnStatus(id, status, now).pipe(
            Effect.provide(input.executionDependencies),
            Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
          ),
        queueMutationEvent: input.queueMutationEvent,
        claimQueuedTurn: (threadId, now) =>
          claimQueuedTurn(threadId, now).pipe(
            Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
          ),
        emit,
        releaseTurnObserver,
        makeTurnId: () => input.options.makeTurnId,
        failureMessage: executionStartFailureMessage,
      })
    })
  const promoteThread = Effect.fn("ProductOperation.interactive.promoteThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    yield* drainQueued(thread, dispatch)
  })
  const settleThread = Effect.fn("ProductOperation.interactive.settleThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    yield* promoteThread(thread, dispatch).pipe(
      Effect.catch(() => drainQueued(thread, dispatch).pipe(Effect.asVoid)),
      Effect.orElseSucceed(() => undefined),
    )
  })
  const activeInThread = Effect.fn("ProductOperation.interactive.activeInThread")(function* (
    threadId: Thread.ThreadId,
  ) {
    const turns = Context.get(dependencyContext, TurnRepository.Service)
    const turn = yield* turns.findActive(threadId)
    if (turn === undefined) return yield* operationError("No active turn")
    return turn
  })
  const active = Effect.gen(function* () {
    const thread = yield* Ref.get(input.interactiveThread)
    if (thread === undefined) return yield* operationError("No thread selected")
    return yield* activeInThread(thread.id)
  }).pipe(Effect.withSpan("ProductOperation.interactive.active"))
  const threadForTurn = Effect.fn("ProductOperation.interactive.threadForTurn")(function* (
    turn: import("@rika/product/turn-record").Turn,
  ) {
    const thread = yield* Context.get(dependencyContext, ThreadRepository.Service).get(turn.threadId)
    if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
    return thread
  })
  return { readQueue, drainQueued, promoteThread, settleThread, activeInThread, active, threadForTurn }
}

export const promotePendingTurns = (input: {
  readonly thread: Thread.Thread
  readonly dispatch: (event: InteractiveEvent) => void
  readonly turns: TurnRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly pendingCapacity: number
  readonly prepareExecution: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
    persist?: boolean,
  ) => Effect.Effect<PreparedTurn, OperationError, never>
  readonly owner: RootTurnOwner.Interface
  readonly notifyThreadSummaries: Effect.Effect<void, OperationError, never>
  readonly notifyTurnChanged: (turn: Pick<Turn.Turn, "id" | "threadId">) => Effect.Effect<void, never, never>
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
  ) => Effect.Effect<Turn.Turn, OperationError, never>
  readonly queueMutationEvent: (change: TurnQueuePromotion.QueueItemChange) => InteractiveEvent
  readonly claimQueuedTurn: (
    threadId: Thread.ThreadId,
    now: number,
  ) => Effect.Effect<TurnQueuePromotion.QueueClaim | undefined, OperationError, never>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<void, never, never>
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly makeTurnId: () => Effect.Effect<Turn.TurnId, never, never>
  readonly failureMessage: string
}): Effect.Effect<
  number,
  | OperationError
  | TurnRepository.QueueFull
  | ExecutionGateway.StartTurnFailure
  | ExecutionGateway.WatchTurnFailure
  | TurnRepository.RepositoryError
  | import("@rika/product/transcript-repository").RepositoryError,
  never
> =>
  Effect.gen(function* () {
    let staleRefused = false
    let claimed = 0
    const refuseStaleQueued = Effect.gen(function* () {
      const queue = yield* input.turns.readQueue(input.thread.id)
      const now = yield* Clock.currentTimeMillis
      const staleError = staleQueuedTurnsError(input.thread.id, queue.turns, now, queuedTurnPromoteMaxAgeMs)
      if (staleError === undefined) return false
      staleRefused = true
      input.emit(input.dispatch, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        threadId: input.thread.id,
        failure: makeFailure(staleError),
      })
      return yield* staleError
    })
    const retryTurn = (failed: {
      readonly turn: Turn.AgentExecutionTurn
      readonly attempt: number
      readonly sourceTurnId: string
      readonly message: string
    }) =>
      Effect.gen(function* () {
        const created = yield* input.turns.createForSubmission({
          id: yield* input.makeTurnId(),
          threadId: input.thread.id,
          prompt: failed.turn.prompt,
          ...(failed.turn.promptParts === undefined ? {} : { promptParts: failed.turn.promptParts }),
          executionRoute: failed.turn.executionRoute,
          lineage: { _tag: "Retried", sourceTurnId: failed.sourceTurnId },
          queueCapacity: input.pendingCapacity,
          now: yield* Clock.currentTimeMillis,
        })
        const retryClaimed = yield* input.owner
          .claim(created.id, created.status)
          .pipe(Effect.mapError((error) => operationError(operationFailureDetail(error), error)))
        if (!retryClaimed) return undefined
        const delay = turnRetryDelay({ attempt: failed.attempt })
        input.emit(input.dispatch, {
          _tag: "TurnRetryScheduled",
          selectionEpoch: 0,
          threadId: input.thread.id,
          turnId: failed.turn.id,
          retryTurnId: created.id,
          attempt: failed.attempt,
          budget: turnRetryBudget,
          message: failed.message,
          nextAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(delay),
        })
        yield* Effect.sleep(delay)
        return created
      })
    const runRetryAttempt = (
      turn: Turn.AgentExecutionTurn,
      attempt: number,
      sourceTurnId: string,
    ): Effect.Effect<
      "settled" | "exhausted",
      | OperationError
      | TurnRepository.QueueFull
      | ExecutionGateway.StartTurnFailure
      | ExecutionGateway.WatchTurnFailure
      | TurnRepository.RepositoryError
      | import("@rika/product/transcript-repository").RepositoryError,
      never
    > =>
      Effect.gen(function* () {
        const prepared = yield* input.prepareExecution(turn, input.thread.workspace, false)
        if (prepared.messages.length > 0)
          input.emit(input.dispatch, {
            _tag: "ContextDiagnostics",
            selectionEpoch: 0,
            threadId: input.thread.id,
            turnId: turn.id,
            messages: prepared.messages,
          })
        const running = yield* input.setTurnStatus(turn.id, "running", yield* Clock.currentTimeMillis)
        if (running.status !== "running") return "exhausted"
        yield* input.notifyThreadSummaries
        yield* input.notifyTurnChanged(running)
        input.emit(input.dispatch, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          activitySequence: 0,
          threadId: input.thread.id,
          turn: running,
        })
        yield* input.owner.startTurn({
          threadId: input.thread.id,
          turnId: turn.id,
          workspaceId: input.thread.workspace,
          prompt: prepared.prompt,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          executionRoute: turn.executionRoute,
          ...(isReviewRouteMode(turn.executionRoute.mode) ? { reviewIntent: reviewIntent(turn.prompt) } : {}),
        })
        const clock = yield* Clock.Clock
        const publish = (change: ExecutionProjection.Change) => {
          input.emit(input.dispatch, {
            _tag: "ExecutionProjectionChanged",
            threadId: input.thread.id,
            turn: { ...turn, status: change.state.status, updatedAt: clock.currentTimeMillisUnsafe() },
            change,
          })
        }
        const publishPreview = (preview: ExecutionGateway.ModelPreviewEvent) => {
          input.emit(input.dispatch, {
            _tag: "ExecutionModelPreviewChanged",
            threadId: input.thread.id,
            turnId: turn.id,
            preview,
          })
        }
        const result = yield* input.owner.watchTurn(turn.id, publish, publishPreview)
        if (result.status === "failed") {
          const failure = turnFailure(result.units)
          const retryable = failure?.retryable ?? false
          if (shouldRetryTurn({ retryable, retry: retryable ? "automatic" : "none", attempt })) {
            const next = yield* retryTurn({
              turn,
              attempt,
              sourceTurnId,
              message: failure?.message ?? "Execution failed",
            })
            if (next !== undefined) return yield* runRetryAttempt(next, attempt + 1, sourceTurnId)
          }
          yield* input.setTurnStatus(turn.id, "failed", yield* Clock.currentTimeMillis)
          return "exhausted"
        }
        yield* input.setTurnStatus(turn.id, result.status, yield* Clock.currentTimeMillis)
        return "settled"
      })
    const runPromoted = (claim: TurnQueuePromotion.QueueClaim) =>
      Effect.gen(function* () {
        const promoted = claim.turn
        const outcome = yield* Effect.gen(function* () {
          const prepared = yield* input.prepareExecution(promoted, input.thread.workspace, false)
          if (prepared.messages.length > 0)
            input.emit(input.dispatch, {
              _tag: "ContextDiagnostics",
              selectionEpoch: 0,
              threadId: input.thread.id,
              turnId: promoted.id,
              messages: prepared.messages,
            })
          const transition = yield* input.turns.finishQueuedClaim(claim, "running", yield* Clock.currentTimeMillis)
          if (transition._tag === "Unavailable") return undefined
          yield* input.notifyThreadSummaries
          yield* input.notifyTurnChanged(transition.turn)
          input.emit(input.dispatch, input.queueMutationEvent(transition.queue))
          if (transition.turn.status !== "running") return undefined
          input.emit(input.dispatch, {
            _tag: "TurnStarted",
            selectionEpoch: 0,
            activitySequence: 0,
            threadId: input.thread.id,
            turn: transition.turn,
          })
          yield* input.owner.startTurn({
            threadId: input.thread.id,
            turnId: promoted.id,
            workspaceId: input.thread.workspace,
            prompt: prepared.prompt,
            ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
            executionRoute: promoted.executionRoute,
            ...(isReviewRouteMode(promoted.executionRoute.mode) ? { reviewIntent: reviewIntent(promoted.prompt) } : {}),
          })
          const clock = yield* Clock.Clock
          const publish = (change: ExecutionProjection.Change) => {
            input.emit(input.dispatch, {
              _tag: "ExecutionProjectionChanged",
              threadId: input.thread.id,
              turn: { ...transition.turn, status: change.state.status, updatedAt: clock.currentTimeMillisUnsafe() },
              change,
            })
          }
          const publishPreview = (preview: ExecutionGateway.ModelPreviewEvent) => {
            input.emit(input.dispatch, {
              _tag: "ExecutionModelPreviewChanged",
              threadId: input.thread.id,
              turnId: promoted.id,
              preview,
            })
          }
          const result = yield* input.owner.watchTurn(promoted.id, publish, publishPreview)
          return result
        }).pipe(
          Effect.map((value) => ({ _tag: "Success" as const, value })),
          Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
          Effect.onError(() => input.turns.releaseQueuedClaim(claim).pipe(Effect.ignore)),
          Effect.onInterrupt(() => input.turns.releaseQueuedClaim(claim)),
        )
        if (outcome._tag === "Failure") {
          const current = yield* input.turns.get(promoted.id)
          if (current?._tag === "AgentExecution" && current.executionLink !== undefined) return false
          if (current?.status === "running")
            yield* input.setTurnStatus(promoted.id, "failed", yield* Clock.currentTimeMillis)
          else {
            const transition = yield* input.turns.finishQueuedClaim(claim, "failed", yield* Clock.currentTimeMillis)
            if (transition._tag === "Unavailable") return true
            yield* input.notifyThreadSummaries
            yield* input.notifyTurnChanged(transition.turn)
            input.emit(input.dispatch, input.queueMutationEvent(transition.queue))
          }
          input.emit(input.dispatch, {
            _tag: "ExecutionFailed",
            selectionEpoch: 0,
            threadId: input.thread.id,
            turnId: promoted.id,
            failure: makeFailure(input.failureMessage),
          })
          return true
        }
        const result = outcome.value
        if (result === undefined) return true
        yield* input.setTurnStatus(promoted.id, result.status, yield* Clock.currentTimeMillis)
        if (result.status === "failed") {
          const failure = turnFailure(result.units)
          const retryable = failure?.retryable ?? false
          if (shouldRetryTurn({ retryable, retry: retryable ? "automatic" : "none", attempt: 1 })) {
            const next = yield* retryTurn({
              turn: promoted,
              attempt: 1,
              sourceTurnId: promoted.id,
              message: failure?.message ?? "Execution failed",
            })
            if (next !== undefined) yield* runRetryAttempt(next, 2, promoted.id)
          }
        }
        return result.status !== "running" && result.status !== "waiting" && result.status !== "cancelling"
      })
    while (true) {
      if (staleRefused || (yield* input.turns.readQueue(input.thread.id)).queuedCount === 0) break
      if ((yield* refuseStaleQueued.pipe(Effect.catchTag("StaleQueuedTurns", () => Effect.succeed(true)))) === true)
        break
      const claim = yield* input.claimQueuedTurn(input.thread.id, yield* Clock.currentTimeMillis)
      if (claim === undefined) break
      claimed += 1
      const keepDraining = yield* Effect.uninterruptible(runPromoted(claim)).pipe(
        Effect.ensuring(input.releaseTurnObserver(claim.turn.id).pipe(Effect.ignore)),
      )
      if (!keepDraining) break
    }
    return claimed
  })
