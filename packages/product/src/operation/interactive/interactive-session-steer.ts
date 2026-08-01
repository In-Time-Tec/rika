import { Function } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect } from "effect"
import { OperationError, operationError, operationFailureDetail } from "../operation-error"
import { OperationUnavailable } from "../contract/product-operation"

const steerInteractiveTurnImpl = (input: any, text: string, targetTurnId?: string) => {
  const safe: <A, E, R>(
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, OperationUnavailable, never> = input.safe
  const active: () => Effect.Effect<import("@rika/product/turn-record").Turn, OperationError, never> = input.active
  const nextSteeringIdentity: (turnId: string) => string = input.nextSteeringIdentity
  return safe(
    input.sessionDispatch,
    Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const turn = yield* active()
      if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
        return yield* operationError(`Steering target ${targetTurnId} is no longer the active turn`)
      const outcome = yield* Effect.exit(backend.steer(turn.id, text, nextSteeringIdentity(String(turn.id))))
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
}

export const steerInteractiveTurn: {
  (arg1: string, arg2?: string): (arg0: any) => ReturnType<typeof steerInteractiveTurnImpl>
  (arg0: any, arg1: string, arg2?: string): ReturnType<typeof steerInteractiveTurnImpl>
} = Function.dual(3, steerInteractiveTurnImpl)
