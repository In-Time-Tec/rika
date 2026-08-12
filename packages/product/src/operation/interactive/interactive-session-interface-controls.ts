import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Clock, Effect, Ref } from "effect"
import { OperationError, operationError } from "../operation-error"
import { makeFailure } from "../operation-failure"
import type { InteractiveSession } from "./interactive-session"
import { OperationUnavailable } from "../contract/product-operation"
import type { InteractiveSessionControlsInput } from "./interactive-session-interface"

const userCancellationReason = "Cancelled by user"

export const makeInteractiveSessionControls = (
  input: InteractiveSessionControlsInput,
): Pick<InteractiveSession, "steer" | "interruptAndSend" | "cancel" | "quit"> => {
  const {
    safe,
    active,
    threadForTurn,
    createForSubmission,
    ensureTurnSummary,
    drainQueued,
    notifyThreadSummaries,
    notifyTurnChanged,
    publishTurnSettled,
    executionDependencies,
    interactiveThread,
    options,
    queueMutationEvent,
    sessionDispatch,
    pendingTurnCapacity,
    emit,
    stopActiveExecutionWorkWithProjection,
    control,
  } = input
  const interruptAndSend = (prompt: string) =>
    safe(
      sessionDispatch,
      Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        const backend = yield* ExecutionGateway.Service
        const turn = yield* active
        const thread = yield* threadForTurn(turn)
        const pending = yield* createForSubmission(turns, {
          id: yield* options.makeTurnId,
          threadId: turn.threadId,
          prompt,
          executionRoute: turn.executionRoute,
          queueCapacity: pendingTurnCapacity,
          now: yield* Clock.currentTimeMillis,
        })
        yield* ensureTurnSummary(pending)
        if (pending.status === "accepted") {
          const requeued = yield* turns.requeueAccepted(pending.id, pendingTurnCapacity, yield* Clock.currentTimeMillis)
          emit(sessionDispatch, queueMutationEvent(requeued.queue))
          yield* drainQueued(thread, sessionDispatch)
          return
        }
        if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
        if (pending.queue !== undefined) emit(sessionDispatch, queueMutationEvent(pending.queue))
        const cancelledAt = yield* Clock.currentTimeMillis
        const cancelledBeforeStart = turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, cancelledAt))
        if (cancelledBeforeStart) {
          const cancelled = yield* turns.get(turn.id)
          yield* notifyThreadSummaries
          if (cancelled !== undefined) {
            yield* notifyTurnChanged(cancelled)
            yield* publishTurnSettled?.(cancelled, false) ?? Effect.void
          }
        } else {
          if (turn.executionLink === undefined)
            return yield* operationError(`Turn ${turn.id} has no persisted execution link`)
          yield* backend.cancelTurn(turn.executionLink, userCancellationReason)
        }
        yield* drainQueued(thread, sessionDispatch)
      }),
    )
  const cancel = safe(
    sessionDispatch,
    Effect.gen(function* () {
      const selectedThread = yield* Ref.get(interactiveThread)
      if (selectedThread === undefined)
        return sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
      const turns = yield* TurnRepository.Service
      const turn = yield* turns.findActive(selectedThread.id)
      if (turn === undefined)
        return sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
      const backend = yield* ExecutionGateway.Service
      const now = yield* Clock.currentTimeMillis
      const beforeStart = turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, now))
      let cancellation: Effect.Effect<void, OperationError | ExecutionGateway.CancelTurnFailure> = Effect.void
      if (!beforeStart) {
        if (turn.executionLink === undefined)
          cancellation = operationError(`Turn ${turn.id} has no persisted execution link`)
        else cancellation = backend.cancelTurn(turn.executionLink, userCancellationReason)
      }
      const outcome = yield* Effect.exit(cancellation)
      if (outcome._tag === "Failure")
        return emit(sessionDispatch, {
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "cancel",
          failure: makeFailure(outcome.cause),
        })
      if (beforeStart) {
        const cancelled = yield* turns.get(turn.id)
        yield* notifyThreadSummaries
        if (cancelled !== undefined) {
          yield* notifyTurnChanged(cancelled)
          yield* publishTurnSettled?.(cancelled, false) ?? Effect.void
        }
      }
      emit(sessionDispatch, {
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "cancelled",
        agentResponseArrived: false,
      })
    }),
  )
  return {
    steer: (text, requestId, targetTurnId) => safe(sessionDispatch, control.steer(text, requestId, targetTurnId)),
    interruptAndSend: (prompt) => interruptAndSend(prompt),
    cancel,
    quit: stopActiveExecutionWorkWithProjection.pipe(
      Effect.provide(executionDependencies),
      Effect.mapError((failure: unknown) =>
        OperationUnavailable.make({ operation: "InteractiveSession.quit", message: String(failure) }),
      ),
    ),
  }
}
