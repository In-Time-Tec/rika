import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { Schema } from "effect"
import { OperationError } from "./operation-error"
import { StaleQueuedTurns } from "../thread/queue/pending-turn-policy"

/**
 * How retrying can succeed. `user` means the person can act and retry;
 * `automatic` means Rika retries with backoff; `never` means the identical
 * attempt fails identically.
 */
export const FailureRetry = Schema.Literals(["user", "automatic", "never"])
/** Who is responsible for resolving the failure. */
export const FailureActor = Schema.Literals(["user", "environment", "rika"])

/**
 * A structured failure crossing the process boundary. The server knows what
 * happened; the TUI decides what to say. Prose-only `message` fields flattened
 * this to a sentence at the wire and made every error unclassifiable.
 */
export const Failure = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  retry: FailureRetry,
  actor: FailureActor,
  correlationId: Schema.optionalKey(Schema.String),
})
export type Failure = typeof Failure.Type

const failureTag = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "_tag" in error && typeof error._tag === "string")
    return error._tag
  return error instanceof Error ? error.name : typeof error
}

const failureMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return error.message
  const encoded = JSON.stringify(error)
  return encoded === undefined || encoded === "{}" ? String(error) : encoded
}

const containsConfigError = (message: string) =>
  message.includes("ConfigError") || message.includes("Missing key") || message.includes("apiKeyEnv")

export const makeFailure = (error: unknown): Failure => {
  const tag = failureTag(error)
  const message = failureMessage(error)

  if (Schema.is(TurnRepository.QueuedTurnUnavailable)(error) || Schema.is(StaleQueuedTurns)(error))
    return { tag, message, retry: "user", actor: "user" }

  if (Schema.is(OperationError)(error)) {
    const cause = error.cause
    if (cause !== undefined && containsConfigError(failureMessage(cause))) {
      return { tag, message, retry: "never", actor: "environment" }
    }
    return { tag, message, retry: "never", actor: "rika" }
  }

  if (
    Schema.is(ExecutionGateway.StartTurnFailure)(error) ||
    Schema.is(ExecutionGateway.CancelTurnFailure)(error) ||
    Schema.is(ExecutionGateway.SteeringFailure)(error) ||
    Schema.is(ExecutionGateway.WatchTurnFailure)(error) ||
    Schema.is(ExecutionGateway.InspectTurnFailure)(error)
  ) {
    if (containsConfigError(message)) return { tag, message, retry: "never", actor: "environment" }
    return { tag, message, retry: "user", actor: "environment" }
  }

  if (containsConfigError(message)) return { tag, message, retry: "never", actor: "environment" }
  return { tag, message, retry: "never", actor: "rika" }
}

export const makeFailureFromError = makeFailure
