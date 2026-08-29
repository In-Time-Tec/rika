import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type * as RootTurnOwner from "../../../thread/queue/root-owner"
import * as TurnQueuePromotion from "../../../thread/repository/turn-queue"
import { Cause, Clock, Effect, Ref, Schema } from "effect"
import { type InteractiveEvent } from "../session-event"
import { OperationError, operationError } from "../../error"
import * as OperationFailure from "../../failure"
import { type InteractiveSession, type InteractiveSessionControlsInput } from "../session"
import { OperationUnavailable } from "../../contract/product"

const routeEquivalent = Schema.toEquivalence(ExecutionRouteSnapshot)
const terminal = (status: Turn.Turn["status"]) =>
  status === "completed" || status === "failed" || status === "cancelled"

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
  const steeringFailed = <ErrorValue>(
    error: ErrorValue,
    requestId: string,
    turn?: Pick<Turn.Turn, "id" | "threadId">,
  ) =>
    input.dispatch(
      turn === undefined
        ? {
            _tag: "ExecutionControlFailed",
            selectionEpoch: 0,
            action: "steer",
            failure: OperationFailure.makeFailure(error),
            steeringRequestId: requestId,
          }
        : {
            _tag: "ExecutionControlFailed",
            selectionEpoch: 0,
            threadId: turn.threadId,
            turnId: turn.id,
            action: "steer",
            failure: OperationFailure.makeFailure(error),
            steeringRequestId: requestId,
          },
    )
  const steer = (text: string, requestId: string, targetTurnId?: string) =>
    Effect.suspend(() => {
      let target: Pick<Turn.Turn, "id" | "threadId"> | undefined
      return Effect.gen(function* () {
        const turn =
          targetTurnId === undefined ? yield* input.active : yield* input.turns.get(Turn.TurnId.make(targetTurnId))
        if (turn === undefined) return yield* input.fail(`Steering target ${targetTurnId} is unavailable`)
        target = turn
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
  const respondToAuthorization = (
    decision: "approve" | "deny",
    id: string,
    authorizationId: string,
    expectedCheckpoint?: ExecutionProjection.Checkpoint,
  ) =>
    Effect.gen(function* () {
      let threadId: Turn.Turn["threadId"] | undefined
      const turnId = Turn.TurnId.make(id)
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const turn = yield* input.turns.get(turnId)
          threadId = turn?.threadId
          if (turn === undefined || turn._tag !== "AgentExecution" || turn.executionLink === undefined)
            return yield* input.fail(`Turn ${turnId} has no persisted execution link`)
          const projection = expectedCheckpoint === undefined ? yield* input.transcripts.get(turnId) : undefined
          const checkpoint = expectedCheckpoint ?? projection?.projectorCheckpoint
          if (checkpoint === undefined)
            return yield* ExecutionGateway.ApprovalResponseFailure.make({
              kind: "stale",
              message: "Authorization is no longer pending",
            })
          yield* decision === "approve"
            ? input.backend.approveTurn(turn.executionLink, {
                authorizationId,
                checkpoint,
              })
            : input.backend.denyTurn(turn.executionLink, {
                authorizationId,
                checkpoint,
              })
          yield* input.notifyTurnChanged(turn)
        }),
      )
      if (outcome._tag === "Failure") {
        const event: Extract<InteractiveEvent, { readonly _tag: "ExecutionControlFailed" }> = {
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          turnId,
          action: decision,
          failure: OperationFailure.makeFailure(Cause.squash(outcome.cause)),
        }
        input.dispatch(threadId === undefined ? event : { ...event, threadId })
      }
    })
  return {
    editQueued,
    dequeue,
    steerQueued,
    steer,
    approveAuthorization: (turnId: string, authorizationId: string, checkpoint?: ExecutionProjection.Checkpoint) =>
      respondToAuthorization("approve", turnId, authorizationId, checkpoint),
    denyAuthorization: (turnId: string, authorizationId: string, checkpoint?: ExecutionProjection.Checkpoint) =>
      respondToAuthorization("deny", turnId, authorizationId, checkpoint),
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
  const cancelActiveTurn = Effect.fn("ProductOperation.cancelActiveTurn")(function* (
    turn: Turn.AgentExecutionTurn,
    turns: TurnRepository.Interface,
    backend: ExecutionGateway.Interface,
  ) {
    const beforeLink =
      turn.executionLink === undefined && (yield* turns.cancelUnlinked(turn.id, yield* Clock.currentTimeMillis))
    let cancellation: Effect.Effect<void, OperationError | ExecutionGateway.CancelTurnFailure> = Effect.void
    if (!beforeLink) {
      const linked = turn.executionLink === undefined ? yield* turns.get(turn.id) : turn
      if (linked === undefined || linked._tag !== "AgentExecution" || linked.executionLink === undefined)
        cancellation = operationError(`Turn ${turn.id} has no persisted execution link`)
      else
        cancellation = backend.cancelTurn(linked.executionLink, userCancellationReason).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              ExecutionGateway.CancelTurnFailure.make({ message: "Durable execution cancellation timed out" }),
          }),
        )
    }
    const outcome = yield* Effect.exit(cancellation)
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning("execution.cancel.unconfirmed").pipe(
        Effect.annotateLogs({
          "rika.thread.id": String(turn.threadId),
          "rika.turn.id": String(turn.id),
          "rika.failure.message": Cause.pretty(outcome.cause),
        }),
      )
      return yield* Effect.failCause(outcome.cause)
    } else if (beforeLink) {
      const cancelled = yield* turns.get(turn.id)
      yield* notifyThreadSummaries
      if (cancelled !== undefined) {
        yield* notifyTurnChanged(cancelled)
        yield* publishTurnSettled?.(cancelled, false) ?? Effect.void
      }
    }
  })
  const interruptAndSend = (prompt: string, targetTurnId?: string, turnId?: Turn.TurnId) =>
    safe(
      sessionDispatch,
      Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        const backend = yield* ExecutionGateway.Service
        const turn = targetTurnId === undefined ? yield* active : yield* turns.get(Turn.TurnId.make(targetTurnId))
        if (turn === undefined || turn._tag !== "AgentExecution")
          return yield* operationError(`Interrupted Turn ${targetTurnId ?? "current"} is unavailable`)
        const thread = yield* threadForTurn(turn)
        const pendingId = turnId ?? (yield* options.makeTurnId)
        const existing = yield* turns.get(pendingId)
        if (
          existing !== undefined &&
          (existing._tag !== "AgentExecution" ||
            existing.threadId !== turn.threadId ||
            existing.prompt !== prompt ||
            !routeEquivalent(existing.executionRoute, turn.executionRoute))
        )
          return yield* operationError(`Turn ${pendingId} exists with a different interrupted submission`)
        const created =
          existing === undefined
            ? yield* createForSubmission(turns, {
                id: pendingId,
                threadId: turn.threadId,
                prompt,
                executionRoute: turn.executionRoute,
                queueCapacity: pendingTurnCapacity,
                now: yield* Clock.currentTimeMillis,
              })
            : undefined
        const pending = existing ?? created!
        yield* ensureTurnSummary(pending)
        if (
          terminal(pending.status) ||
          pending.status === "running" ||
          pending.status === "cancelling" ||
          pending.status === "waiting"
        )
          return
        if (pending.status === "accepted") {
          const requeued = yield* turns.requeueAccepted(pending.id, pendingTurnCapacity, yield* Clock.currentTimeMillis)
          emit(sessionDispatch, queueMutationEvent(requeued.queue))
          yield* drainQueued(thread, sessionDispatch)
          return
        }
        if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
        if (created?.queue !== undefined) emit(sessionDispatch, queueMutationEvent(created.queue))
        const target = yield* turns.get(turn.id)
        if (target !== undefined && target._tag === "AgentExecution" && !terminal(target.status))
          yield* cancelActiveTurn(target, turns, backend)
        yield* drainQueued(thread, sessionDispatch)
      }),
    )
  const cancel: InteractiveSession["cancel"] = (target = {}) =>
    Effect.suspend(() => {
      let turn: Turn.Turn | undefined
      return Effect.gen(function* () {
        const selectedThread = yield* Ref.get(interactiveThread)
        if (selectedThread === undefined) {
          if (target.turnId !== undefined || target.threadId !== undefined)
            return yield* operationError("Cancellation target Thread is not selected")
          return sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
        }
        if (target.threadId !== undefined && target.threadId !== selectedThread.id)
          return yield* operationError(`Thread ${target.threadId} is not selected`)
        const turns = yield* TurnRepository.Service
        turn =
          target.turnId === undefined
            ? yield* turns.findActive(selectedThread.id)
            : yield* turns.get(Turn.TurnId.make(target.turnId))
        if (turn === undefined) {
          if (target.turnId !== undefined) return yield* operationError(`Turn ${target.turnId} is unavailable`)
          return sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
        }
        if (turn.threadId !== selectedThread.id)
          return yield* operationError(`Turn ${turn.id} does not belong to the selected Thread`)
        if (terminal(turn.status))
          return sessionDispatch({
            _tag: "ExecutionControlled",
            selectionEpoch: 0,
            threadId: turn.threadId,
            turnId: turn.id,
            action: "cancelled",
            agentResponseArrived: turn.status === "completed",
          })
        if (turn._tag !== "AgentExecution") return yield* operationError(`Turn ${turn.id} cannot be cancelled`)
        const backend = yield* ExecutionGateway.Service
        yield* cancelActiveTurn(turn, turns, backend)
        emit(sessionDispatch, {
          _tag: "ExecutionControlled",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "cancelled",
          agentResponseArrived: false,
        })
        const thread = yield* threadForTurn(turn)
        yield* drainQueued(thread, sessionDispatch)
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() => {
            if (turn === undefined) {
              sessionDispatch({
                _tag: "ExecutionControlFailed",
                selectionEpoch: 0,
                action: "cancel",
                failure: OperationFailure.makeFailure(error),
              })
              return
            }
            sessionDispatch({
              _tag: "ExecutionControlFailed",
              selectionEpoch: 0,
              threadId: turn.threadId,
              turnId: turn.id,
              action: "cancel",
              failure: OperationFailure.makeFailure(error),
            })
          }),
        ),
      )
    })
  return {
    steer: (text, requestId, targetTurnId) => safe(sessionDispatch, control.steer(text, requestId, targetTurnId)),
    interruptAndSend,
    cancel,
    quit: stopActiveExecutionWorkWithProjection.pipe(
      Effect.provide(executionDependencies),
      Effect.mapError((failure) =>
        OperationUnavailable.make({ operation: "InteractiveSession.quit", message: String(failure) }),
      ),
    ),
  }
}
