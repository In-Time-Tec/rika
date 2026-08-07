import { Clock, Effect } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnQueuePromotion from "../../thread/repository/turn-repository-queue"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { OperationError } from "../operation-error"
import { makeFailure } from "../operation-failure"
import type { operationError } from "../operation-error"

export const makeInteractiveControl = (input: {
  readonly turns: TurnRepository.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly pendingCapacity: number
  readonly active: Effect.Effect<Turn.Turn, OperationError | TurnRepository.RepositoryError, never>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly queueMutation: (change: TurnQueuePromotion.QueueItemChange) => InteractiveEvent
  readonly nextSteeringIdentity: (turnId: string) => string
  readonly notifyTurnChanged: (turn: Pick<Turn.Turn, "id" | "threadId">) => Effect.Effect<void, never, never>
  readonly fail: typeof operationError
}) => {
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
  const steer = (text: string, targetTurnId?: string) =>
    Effect.gen(function* () {
      const turn = yield* input.active
      if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
        return yield* input.fail(`Steering target ${targetTurnId} is no longer the active turn`)
      if (turn._tag !== "AgentExecution" || turn.executionLink === undefined)
        return yield* input.fail(`Turn ${turn.id} has no persisted execution link`)
      const outcome = yield* Effect.exit(
        input.backend.steerTurn(turn.executionLink, {
          text,
          idempotencyKey: input.nextSteeringIdentity(String(turn.id)),
        }),
      )
      if (outcome._tag === "Failure") {
        input.dispatch({
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "steer",
          failure: makeFailure(outcome.cause),
          steeringText: text,
        })
        return
      }
      input.dispatch({
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "steered",
        steeringText: text,
      })
    })
  const steerQueued = (id: string, text: string) =>
    Effect.gen(function* () {
      const turn = yield* input.active
      const candidate = yield* input.turns.get(Turn.TurnId.make(id))
      if (candidate?.status === "queued" && candidate.promptParts?.some((part) => part.type === "image") === true)
        return yield* input.fail("Queued turns with images cannot be steered")
      const taken = yield* input.turns.takeQueued(Turn.TurnId.make(id))
      const queued = taken.turn
      const steeringText =
        queued.promptParts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("") ??
        queued.prompt ??
        text
      input.dispatch(input.queueMutation(taken.queue))
      if (turn._tag !== "AgentExecution" || turn.executionLink === undefined)
        return yield* input.fail(`Turn ${turn.id} has no persisted execution link`)
      const outcome = yield* Effect.exit(
        input.backend.steerTurn(turn.executionLink, {
          text: steeringText,
          idempotencyKey: `rika:queued-steer:${queued.id}`,
        }),
      )
      if (outcome._tag === "Failure") {
        const restored = yield* input.turns.copy(queued, input.pendingCapacity)
        if (restored.queue === undefined) return yield* input.fail(`Turn ${queued.id} was not restored to its queue`)
        input.dispatch(input.queueMutation(restored.queue))
        input.dispatch({
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "steer",
          failure: makeFailure(outcome.cause),
          steeringText,
        })
        return
      }
      input.dispatch({
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "steered",
        steeringText,
      })
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
