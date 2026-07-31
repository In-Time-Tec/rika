import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect } from "effect"
import { operationError, operationFailureDetail } from "../operation-error"

export const steerInteractiveTurn = (input: any, text: string, targetTurnId?: string) =>
  input.safe(
    input.sessionDispatch,
    Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const turn = yield* input.active()
      if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
        return yield* operationError(`Steering target ${targetTurnId} is no longer the active turn`)
      const outcome = yield* Effect.exit(backend.steer(turn.id, text, input.nextSteeringIdentity(String(turn.id))))
      if (outcome._tag === "Failure")
        return input.emit(input.sessionDispatch, {
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "steer",
          message: operationFailureDetail(outcome.cause),
          steeringText: text,
        })
      input.emit(input.sessionDispatch, {
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "steered",
        steeringSequence: outcome.value.sequence,
        steeringText: text,
      })
    }),
  )
