import * as ExecutionGateway from "../execution/gateway/service"
import { Function } from "effect"
import * as TurnRepository from "../thread/repository/turn"
import { Cause, Schema } from "effect"
import { StaleQueuedTurns } from "../thread/queue/pending-policy"

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
} = Function.dual((args) => args.length === 2 || Schema.is(Schema.String)(args[0]), operationErrorImpl)

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  const tagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))(failure)
  if (tagged._tag === "Some") return tagged.value._tag
  if (failure instanceof Error) return failure.name
  return "unknown"
}

export const operationFailureDetail = <ErrorValue>(error: ErrorValue) => {
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
