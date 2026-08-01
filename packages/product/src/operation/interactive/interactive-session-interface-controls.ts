import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Clock, Effect, Ref } from "effect"
import { operationError, operationFailureDetail } from "../operation-error"
import { steerInteractiveTurn } from "./interactive-session-steer"
import type { InteractiveSession } from "./interactive-session"
import { OperationUnavailable } from "../contract/product-operation-errors"
import { agentResponseArrived } from "./interactive-session-interface-support"

export const makeInteractiveSessionControls = (
  input: any,
): Pick<InteractiveSession, "steer" | "interruptAndSend" | "cancel" | "quit"> => {
  const steer = (text: string, targetTurnId?: string) => steerInteractiveTurn(input, text, targetTurnId)
  const interruptAndSend = (prompt: string) =>
    input.safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
        const backend = yield* ExecutionBackend.Service
        const turn = yield* input.active()
        const thread = yield* input.threadForTurn(turn)
        const pending = yield* input.createForSubmission(turns, {
          id: yield* input.options.makeTurnId,
          threadId: turn.threadId,
          prompt,
          executionRoute: turn.executionRoute,
          queueCapacity: input.pendingTurnCapacity,
          now: yield* Clock.currentTimeMillis,
        })
        yield* input.ensureTurnSummary(pending)
        if (pending.status === "accepted") {
          const requeued = yield* turns.requeueAccepted(
            pending.id,
            input.pendingTurnCapacity,
            yield* Clock.currentTimeMillis,
          )
          input.emit(input.sessionDispatch, input.queueMutationEvent(requeued.queue))
          yield* input.drainQueued(thread, input.sessionDispatch)
          return
        }
        if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
        if (pending.queue !== undefined) input.emit(input.sessionDispatch, input.queueMutationEvent(pending.queue))
        const cancelledAt = yield* Clock.currentTimeMillis
        const cancelledBeforeStart = turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, cancelledAt))
        if (cancelledBeforeStart) {
          const cancelled = yield* turns.get(turn.id)
          yield* input.notifyThreadSummaries
          if (cancelled !== undefined) yield* input.notifyTurnChanged(cancelled)
        } else {
          const result = yield* backend.cancel(turn.id)
          input.deliverResultEvents(turn.id, result.events)
          yield* input.setTurnStatus(
            turn.id,
            result.status,
            result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          yield* input.projectExecutionResult(turn.threadId, result)
        }
        yield* input.drainQueued(thread, input.sessionDispatch)
      }),
    )
  const cancel = input.safe(
    input.sessionDispatch,
    Effect.gen(function* () {
      const selectedThread = (yield* Ref.get(input.interactiveThread)) as Thread.Thread | undefined
      if (selectedThread === undefined)
        return input.sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
      const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
      const turn = yield* turns.findActive(selectedThread.id)
      if (turn === undefined)
        return input.sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
      const backend = yield* ExecutionBackend.Service
      const thread = yield* input.threadForTurn(turn)
      const now = yield* Clock.currentTimeMillis
      yield* turns.requestStop(turn.id, now)
      const beforeStart = turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, now))
      const outcome = yield* beforeStart
        ? Effect.exit(Effect.succeed({ turnId: turn.id, status: "cancelled" as const, events: [] }))
        : Effect.exit(backend.cancel(turn.id))
      if (outcome._tag === "Failure")
        return input.emit(input.sessionDispatch, {
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "cancel",
          message: operationFailureDetail(outcome.cause),
        })
      const result = outcome.value
      input.deliverResultEvents(turn.id, result.events)
      if (beforeStart) {
        const cancelled = yield* turns.get(turn.id)
        yield* input.notifyThreadSummaries
        if (cancelled !== undefined) yield* input.notifyTurnChanged(cancelled)
      }
      yield* input.setTurnStatus(
        turn.id,
        result.status,
        ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
      yield* input.projectExecutionResult(turn.threadId, result)
      if (input.isTerminalStatus(result.status)) yield* input.ensureIngest(turn.threadId, turn.id)
      if (result.status === "cancelled")
        input.emit(input.sessionDispatch, {
          _tag: "ExecutionControlled",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "cancelled",
          agentResponseArrived: agentResponseArrived(result.events),
        })
      else if (
        result.status === "failed" &&
        !result.events.some((event: ExecutionEvent.Event) => event.type === "execution.failed")
      )
        input.emit(input.sessionDispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          message: `Execution ${result.status}`,
        })
      if (input.isTerminalStatus(result.status)) yield* input.settleThread(thread, input.sessionDispatch)
    }),
  )
  return {
    steer: (text, targetTurnId) => steer(text, targetTurnId),
    interruptAndSend: (prompt) => interruptAndSend(prompt),
    cancel,
    quit: input.stopActiveExecutionWorkWithProjection().pipe(
      Effect.provide(input.executionDependencies),
      Effect.mapError((failure: unknown) =>
        OperationUnavailable.make({ operation: "InteractiveSession.quit", message: String(failure) }),
      ),
    ),
  }
}
