import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Context, Clock, Effect, Ref } from "effect"
import { OperationError, operationError, operationFailureDetail } from "../operation-error"
import { steerInteractiveTurn } from "./interactive-session-steer"
import type { InteractiveSession } from "./interactive-session"
import { OperationUnavailable } from "../contract/product-operation"
import { agentResponseArrived } from "./interactive-session-interface-support"

export const makeInteractiveSessionControls = (
  input: any,
): Pick<InteractiveSession, "steer" | "interruptAndSend" | "cancel" | "quit"> => {
  const safe: <A, E, R>(
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, OperationUnavailable, never> = input.safe
  const typedActive: () => Effect.Effect<Turn.AgentExecutionTurn, OperationError, never> = input.active
  const typedThreadForTurn: (turn: Turn.Turn) => Effect.Effect<Thread.Thread, OperationError, never> =
    input.threadForTurn
  const typedCreateForSubmission: (
    turns: TurnRepository.Interface,
    submission: import("../../thread/repository/turn-repository-contract").CreateInput,
  ) => Effect.Effect<import("../../thread/repository/turn-repository-queue").Submission, OperationError, never> =
    input.createForSubmission
  const typedEnsureTurnSummary: (turn: Turn.Turn) => Effect.Effect<void, OperationError, never> =
    input.ensureTurnSummary
  const typedSetTurnStatus: (
    id: Turn.TurnId,
    status: import("@rika/product/execution-status").Status,
    cursor: string | undefined,
    now: number,
  ) => Effect.Effect<Turn.Turn, OperationError, never> = input.setTurnStatus
  const typedProjectExecutionResult: (
    threadId: Turn.Turn["threadId"],
    result: ExecutionEvent.Result,
  ) => Effect.Effect<void, OperationError, never> = input.projectExecutionResult
  const typedDrainQueued: (
    thread: Thread.Thread,
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
  ) => Effect.Effect<number, OperationError, never> = input.drainQueued
  const typedNotifyThreadSummaries: Effect.Effect<void, OperationError, never> = input.notifyThreadSummaries
  const typedNotifyTurnChanged: (
    turn: Pick<Turn.Turn, "id" | "threadId">,
  ) => Effect.Effect<void, OperationError, never> = input.notifyTurnChanged
  const typedExecutionDependencies: Context.Context<TurnRepository.Service | ExecutionBackend.Service> =
    input.executionDependencies
  const typedInteractiveThread: Ref.Ref<Thread.Thread | undefined> = input.interactiveThread
  const typedMakeTurnId: Effect.Effect<Turn.TurnId, never, never> = input.options.makeTurnId
  const typedQueueMutationEvent: (
    change: import("../../thread/repository/turn-repository-queue").QueueItemChange,
  ) => import("./interactive-event").InteractiveEvent = input.queueMutationEvent
  const typedIsTerminalStatus: (status: import("@rika/product/execution-status").Status) => boolean =
    input.isTerminalStatus
  const typedEnsureIngest: (
    threadId: Turn.Turn["threadId"],
    turnId: Turn.Turn["id"],
  ) => Effect.Effect<void, OperationError, never> = input.ensureIngest
  const typedSettleThread: (
    thread: Thread.Thread,
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationError, never> = input.settleThread
  const steer = (text: string, targetTurnId?: string) => steerInteractiveTurn(input, text, targetTurnId)
  const interruptAndSend = (prompt: string) =>
    safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
        const backend = yield* ExecutionBackend.Service
        const turn = yield* typedActive()
        const thread = yield* typedThreadForTurn(turn)
        const pending = yield* typedCreateForSubmission(turns, {
          id: yield* typedMakeTurnId,
          threadId: turn.threadId,
          prompt,
          executionRoute: turn.executionRoute,
          queueCapacity: input.pendingTurnCapacity,
          now: yield* Clock.currentTimeMillis,
        })
        yield* typedEnsureTurnSummary(pending)
        if (pending.status === "accepted") {
          const requeued = yield* turns.requeueAccepted(
            pending.id,
            input.pendingTurnCapacity,
            yield* Clock.currentTimeMillis,
          )
          input.emit(input.sessionDispatch, typedQueueMutationEvent(requeued.queue))
          yield* typedDrainQueued(thread, input.sessionDispatch)
          return
        }
        if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
        if (pending.queue !== undefined) input.emit(input.sessionDispatch, typedQueueMutationEvent(pending.queue))
        const cancelledAt = yield* Clock.currentTimeMillis
        const cancelledBeforeStart = turn.status === "accepted" && (yield* turns.cancelAccepted(turn.id, cancelledAt))
        if (cancelledBeforeStart) {
          const cancelled = yield* turns.get(turn.id)
          yield* typedNotifyThreadSummaries
          if (cancelled !== undefined) yield* typedNotifyTurnChanged(cancelled)
        } else {
          const result = yield* backend.cancel(turn.id)
          input.deliverResultEvents(turn.id, result.events)
          yield* typedSetTurnStatus(
            turn.id,
            result.status,
            result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          yield* typedProjectExecutionResult(turn.threadId, result)
        }
        yield* typedDrainQueued(thread, input.sessionDispatch)
      }),
    )
  const cancel = safe(
    input.sessionDispatch,
    Effect.gen(function* () {
      const selectedThread = (yield* Ref.get(typedInteractiveThread)) as Thread.Thread | undefined
      if (selectedThread === undefined)
        return input.sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
      const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
      const turn = yield* turns.findActive(selectedThread.id)
      if (turn === undefined)
        return input.sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
      const backend = yield* ExecutionBackend.Service
      const thread = yield* typedThreadForTurn(turn)
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
        yield* typedNotifyThreadSummaries
        if (cancelled !== undefined) yield* typedNotifyTurnChanged(cancelled)
      }
      yield* typedSetTurnStatus(
        turn.id,
        result.status,
        ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
      yield* typedProjectExecutionResult(turn.threadId, result)
      if (typedIsTerminalStatus(result.status) === true) yield* typedEnsureIngest(turn.threadId, turn.id)
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
      if (typedIsTerminalStatus(result.status) === true) yield* typedSettleThread(thread, input.sessionDispatch)
    }),
  )
  return {
    steer: (text, targetTurnId) => steer(text, targetTurnId),
    interruptAndSend: (prompt) => interruptAndSend(prompt),
    cancel,
    quit: input.stopActiveExecutionWorkWithProjection().pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.mapError((failure: unknown) =>
        OperationUnavailable.make({ operation: "InteractiveSession.quit", message: String(failure) }),
      ),
    ),
  }
}
