import * as ExecutionBackend from "../execution/contract/execution-service"
import * as TurnRepository from "../thread/repository/turn-repository"
import { Cause, Schema } from "effect"
import { StaleQueuedTurns } from "../thread/queue/pending-turn-policy"

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("OperationError", {
  message: Schema.String,
}) {}

export const operationError = (message: string) => OperationError.make({ message })

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
  if (Schema.is(ExecutionBackend.BackendError)(error) && error.message.includes("cursor did not advance"))
    return error.message
  return "Rika could not complete that action. Run rika diagnostics status if it keeps happening."
}
