import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type * as RootTurnOwner from "../../../thread/queue/root-turn-owner"
import * as TurnQueuePromotion from "../../../thread/repository/turn-repository-queue"
import { Clock, Effect, Ref } from "effect"
import { type InteractiveEvent } from "../session-event"
import { OperationError, operationError } from "../../operation-error"
import { makeFailure } from "../../operation-failure"
import { type InteractiveSession, type InteractiveSessionControlsInput } from "../session"
import { OperationUnavailable } from "../../contract/product-operation"

export const makeInteractiveControl = (input: {
  readonly turns: TurnRepository.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly rootTurnOwner: RootTurnOwner.Interface
  readonly active: Effect.Effect<Turn.Turn, OperationError | TurnRepository.RepositoryError, never>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly queueMutation: (change: TurnQueuePromotion.QueueItemChange) => InteractiveEvent
  readonly notifyTurnChanged: (turn: Pick<Turn.Turn, "id" | "threadId">) => Effect.Effect<void, never, never>
  readonly fail: typeof operationError
}) => {
  /**
   * A steer carries whatever the caller wrote, and a queued turn's prompt has no size bound of its
   * own, so any prompt past the composer's convenience limit reached this path and was refused.
   * The refusal consumed the queued row and delivered nothing, which read as a steer that silently
   * vanished. TenetKit bounds a steering prompt by the same message limits as any other prompt, and
   * the projection stopped enforcing this number when it stopped throwing on oversized internal
   * steers, so enforcing it here only rejected work the rest of the system accepts.
   */
  const editQueued = (id: string, prompt: string) =>
    Effect.gen(function* () {
      const turnId = Turn.TurnId.make(id)
      if ((yield* input.turns.get(turnId))?.status !== "queued")
        return yield* input.fail(`Turn ${turnId} is not queued`)
      const turn = yield* input.turns.editQueued(turnId, prompt, yield* Clock.currentTimeMillis)
      input.dispatch(input.queueMutation(turn.queue))
    })
  const dequeue = (id: string) =>
    Effect.gen(function* () {
      input.dispatch(input.queueMutation(yield* input.turns.dequeue(Turn.TurnId.make(id))))
    })
  const steeringFailed = (error: unknown, requestId: string, turn?: Pick<Turn.Turn, "id" | "threadId">) =>
    input.dispatch({
      _tag: "ExecutionControlFailed",
      selectionEpoch: 0,
      ...(turn === undefined ? {} : { threadId: turn.threadId, turnId: turn.id }),
      action: "steer",
      failure: makeFailure(error),
      steeringRequestId: requestId,
    })
  const steer = (text: string, requestId: string, targetTurnId?: string) =>
    Effect.suspend(() => {
      let target: Pick<Turn.Turn, "id" | "threadId"> | undefined
      return Effect.gen(function* () {
        const turn = yield* input.active
        target = turn
        if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
          return yield* input.fail(`Steering target ${targetTurnId} is no longer the active turn`)
        if (turn._tag !== "AgentExecution" || turn.executionLink === undefined)
          return yield* input.fail(`Turn ${turn.id} has no persisted execution link`)
        yield* input.rootTurnOwner.prepareSteering(turn.executionLink, {
          text,
          idempotencyKey: requestId,
        })
        yield* input.notifyTurnChanged(turn)
      }).pipe(Effect.catch((error) => Effect.sync(() => steeringFailed(error, requestId, target))))
    })
  const steerQueued = (id: string, text: string, requestId: string) =>
    Effect.suspend(() => {
      let target: Pick<Turn.Turn, "id" | "threadId"> | undefined
      let steeringText = text
      return Effect.gen(function* () {
        const turn = yield* input.active
        target = turn
        if (turn._tag !== "AgentExecution" || turn.executionLink === undefined)
          return yield* input.fail(`Turn ${turn.id} has no persisted execution link`)
        const candidate = yield* input.turns.get(Turn.TurnId.make(id))
        if (candidate?._tag !== "AgentExecution" || candidate.status !== "queued")
          return yield* input.fail(`Turn ${id} is not queued`)
        if (candidate.threadId !== turn.threadId)
          return yield* input.fail(`Queued turn ${id} does not belong to active turn ${turn.id}`)
        if (candidate.promptParts?.some((part) => part.type === "image") === true)
          return yield* input.fail("Queued turns with images cannot be steered")
        steeringText =
          candidate.promptParts
            ?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("") ??
          candidate.prompt ??
          text
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const prepared = yield* input.rootTurnOwner.prepareQueuedSteering(candidate.id, turn.executionLink!, {
              text: steeringText,
              idempotencyKey: requestId,
            })
            if (prepared.queueChanged) input.dispatch(input.queueMutation(prepared.queue))
            yield* input.notifyTurnChanged(turn)
          }),
        )
      }).pipe(Effect.catch((error) => Effect.sync(() => steeringFailed(error, requestId, target))))
    })
  const respondToAuthorization = (decision: "approve" | "deny", id: string, authorizationId: string) =>
    Effect.gen(function* () {
      let threadId: Turn.Turn["threadId"] | undefined
      const turnId = Turn.TurnId.make(id)
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const turn = yield* input.turns.get(turnId)
          threadId = turn?.threadId
          if (turn === undefined || turn._tag !== "AgentExecution" || turn.executionLink === undefined)
            return yield* input.fail(`Turn ${turnId} has no persisted execution link`)
          const projection = yield* input.transcripts.get(turnId)
          if (projection?.projectorCheckpoint === undefined)
            return yield* ExecutionGateway.ApprovalResponseFailure.make({
              kind: "stale",
              message: "Authorization is no longer pending",
            })
          yield* decision === "approve"
            ? input.backend.approveTurn(turn.executionLink, {
                authorizationId,
                checkpoint: projection.projectorCheckpoint,
              })
            : input.backend.denyTurn(turn.executionLink, {
                authorizationId,
                checkpoint: projection.projectorCheckpoint,
              })
          yield* input.notifyTurnChanged(turn)
        }),
      )
      if (outcome._tag === "Failure")
        input.dispatch({
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          ...(threadId === undefined ? {} : { threadId }),
          turnId,
          action: decision,
          failure: makeFailure(outcome.cause),
        })
    })
  return {
    editQueued,
    dequeue,
    steerQueued,
    steer,
    approveAuthorization: (turnId: string, authorizationId: string) =>
      respondToAuthorization("approve", turnId, authorizationId),
    denyAuthorization: (turnId: string, authorizationId: string) =>
      respondToAuthorization("deny", turnId, authorizationId),
  }
}

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
