import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { Predicate, Schema } from "effect"
import { FailureCategory } from "./failure-policy"
import { OperationError } from "./error"
import { StaleQueuedTurns } from "../thread/queue/pending-policy"

/**
 * A structured failure crossing the process boundary. The chokepoint
 * (`failure-policy.ts`) assigns `category`, `retryable`, and `retry` where the
 * failure is created; the TUI only renders `message`. No instruction prose.
 */

/** Whether Rika retries the failing operation automatically. */
export const FailureRetry = Schema.Literals(["automatic", "none"])
/** Who is responsible for resolving the failure. */
export const FailureActor = Schema.Literals(["user", "environment", "rika"])

export const Failure = Schema.Struct({
  tag: Schema.String,
  category: FailureCategory,
  message: Schema.String,
  retryable: Schema.Boolean,
  retry: FailureRetry,
  actor: FailureActor,
  correlationId: Schema.optionalKey(Schema.String),
})
export type Failure = typeof Failure.Type

const TaggedFailure = Schema.Struct({ _tag: Schema.String })

const failureTag = <ErrorValue>(error: ErrorValue): string => {
  if (Schema.is(TaggedFailure)(error)) return error._tag
  if (error instanceof Error) return error.name
  if (Schema.is(Schema.String)(error)) return "string"
  if (Predicate.isNumber(error)) return "number"
  if (Schema.is(Schema.Boolean)(error)) return "boolean"
  if (Predicate.isSymbol(error)) return "symbol"
  if (Schema.is(Schema.Undefined)(error)) return "undefined"
  if (Predicate.isFunction(error)) return "function"
  return "object"
}

const failureMessage = <ErrorValue>(error: ErrorValue): string => {
  if (error instanceof Error && error.message.length > 0) return error.message
  const encoded = JSON.stringify(error)
  return encoded === undefined || encoded === "{}" ? String(error) : encoded
}

const containsConfigError = (message: string) =>
  message.includes("ConfigError") || message.includes("Missing key") || message.includes("apiKeyEnv")

const gateways = [
  ExecutionGateway.StartTurnFailure,
  ExecutionGateway.CancelTurnFailure,
  ExecutionGateway.SteeringFailure,
  ExecutionGateway.WatchTurnFailure,
  ExecutionGateway.InspectTurnFailure,
]

export const makeFailure = <ErrorValue>(error: ErrorValue): Failure => {
  const tag = failureTag(error)
  const message = failureMessage(error)

  if (Schema.is(TurnRepository.QueuedTurnUnavailable)(error) || Schema.is(StaleQueuedTurns)(error))
    return { tag, category: "operation", message, retryable: true, retry: "none", actor: "user" }

  if (Schema.is(OperationError)(error)) {
    const cause = error.cause
    if (cause !== undefined && containsConfigError(failureMessage(cause)))
      return { tag, category: "operation", message, retryable: false, retry: "none", actor: "environment" }
    return { tag, category: "defect", message, retryable: false, retry: "none", actor: "rika" }
  }

  if (gateways.some((gateway) => Schema.is(gateway)(error))) {
    if (containsConfigError(message))
      return { tag, category: "operation", message, retryable: false, retry: "none", actor: "environment" }
    return { tag, category: "operation", message, retryable: true, retry: "none", actor: "environment" }
  }

  if (containsConfigError(message))
    return { tag, category: "operation", message, retryable: false, retry: "none", actor: "environment" }
  return { tag, category: "defect", message, retryable: false, retry: "none", actor: "rika" }
}
