import * as ExecutionGateway from "../execution/contract/execution-gateway"
import { Function } from "effect"
import * as TurnRepository from "../thread/repository/turn-repository"
import { Cause, Schema } from "effect"
import { StaleQueuedTurns } from "../thread/queue/pending-turn-policy"

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

const operationErrorImpl = (message: string, cause?: unknown) =>
  cause === undefined ? OperationError.make({ message }) : OperationError.make({ message, cause })

export const operationError: {
  (message: string): OperationError
  (cause?: unknown): (message: string) => OperationError
  (message: string, cause?: unknown): OperationError
} = Function.dual((args) => args.length === 2 || typeof args[0] === "string", operationErrorImpl)

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

export const operationFailureDetail = (error: unknown) => {
  if (
    Schema.is(OperationError)(error) ||
    Schema.is(TurnRepository.QueuedTurnUnavailable)(error) ||
    Schema.is(StaleQueuedTurns)(error)
  )
    return error.message
  if (
    (Schema.is(ExecutionGateway.StartTurnFailure)(error) ||
      Schema.is(ExecutionGateway.CancelTurnFailure)(error) ||
      Schema.is(ExecutionGateway.SteeringFailure)(error) ||
      Schema.is(ExecutionGateway.WatchTurnFailure)(error) ||
      Schema.is(ExecutionGateway.InspectTurnFailure)(error)) &&
    error.message.includes("cursor did not advance")
  )
    return error.message
  return "Rika could not complete that action. Run rika diagnostics status if it keeps happening."
}
