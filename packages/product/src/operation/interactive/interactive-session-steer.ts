import { Function } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Effect } from "effect"
import { OperationError, operationError, operationFailureDetail } from "../operation-error"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { InteractiveImplementationInput } from "./interactive-session-interface"

export interface InteractiveSteerInput {
  readonly safe: InteractiveImplementationInput["safe"]
  readonly active: Effect.Effect<Turn.Turn, OperationError | TurnRepository.RepositoryError, never>
  readonly nextSteeringIdentity: (turnId: string) => string
  readonly sessionDispatch: (event: InteractiveEvent) => void
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
}

const steerInteractiveTurnImpl = (input: InteractiveSteerInput, text: string, targetTurnId?: string) => {
  const { safe, active, nextSteeringIdentity, sessionDispatch, emit } = input
  return safe(
    sessionDispatch,
    Effect.gen(function* () {
      const backend = yield* ExecutionGateway.Service
      const turn = yield* active
      if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
        return yield* operationError(`Steering target ${targetTurnId} is no longer the active turn`)
      if (turn._tag !== "AgentExecution" || turn.executionLink === undefined)
        return yield* operationError(`Turn ${turn.id} has no persisted execution link`)
      const outcome = yield* Effect.exit(
        backend.steerTurn(turn.executionLink, { text, idempotencyKey: nextSteeringIdentity(String(turn.id)) }),
      )
      if (outcome._tag === "Failure")
        return emit(sessionDispatch, {
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "steer",
          message: operationFailureDetail(outcome.cause),
          steeringText: text,
        })
      emit(sessionDispatch, {
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "steered",
        steeringText: text,
      })
    }),
  )
}

export const steerInteractiveTurn: {
  (arg1: string, arg2?: string): (arg0: InteractiveSteerInput) => ReturnType<typeof steerInteractiveTurnImpl>
  (arg0: InteractiveSteerInput, arg1: string, arg2?: string): ReturnType<typeof steerInteractiveTurnImpl>
} = Function.dual(3, steerInteractiveTurnImpl)
