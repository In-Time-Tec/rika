import { Clock, Effect } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import * as TurnQueuePromotion from "../../thread/repository/turn-repository-queue"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { OperationError } from "../operation-error"
import { makeFailure } from "../operation-failure"
import type { operationError } from "../operation-error"

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
  const validateSteering = (text: string) =>
    text.length > ExecutionGateway.SteeringTextMaxCharacters
      ? input.fail(`Steering text exceeds ${ExecutionGateway.SteeringTextMaxCharacters} characters`)
      : Effect.void
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
        yield* validateSteering(text)
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
        yield* validateSteering(steeringText)
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
