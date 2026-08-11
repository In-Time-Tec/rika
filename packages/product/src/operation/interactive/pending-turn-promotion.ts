import { OperationError } from "../operation-error"
import { Clock, Duration, Effect } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { isReviewRouteMode, reviewIntent } from "../review/review-policy"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnQueuePromotion from "../../thread/repository/turn-repository-queue"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import { turnFailure } from "../failure-message"
import { makeFailure } from "../operation-failure"
import { shouldRetryTurn, turnRetryBudget, turnRetryDelay } from "../turn-retry-policy"
import { operationError, operationFailureDetail } from "../operation-error"
import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { PreparedTurn } from "./interactive-session-runtime"

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
          workspace: input.thread.workspace,
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
        const publishPreview = (preview: ExecutionGateway.ModelPreviewed) => {
          input.emit(input.dispatch, {
            _tag: "ExecutionModelPreviewed",
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
            workspace: input.thread.workspace,
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
          const publishPreview = (preview: ExecutionGateway.ModelPreviewed) => {
            input.emit(input.dispatch, {
              _tag: "ExecutionModelPreviewed",
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
          Effect.onInterrupt(() => input.turns.releaseQueuedClaim(claim)),
        )
        if (outcome._tag === "Failure") {
          const current = yield* input.turns.get(promoted.id)
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
