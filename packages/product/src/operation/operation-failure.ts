import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { Schema } from "effect"
import { FailureCategory } from "./failure-policy"
import { OperationError } from "./operation-error"
import { StaleQueuedTurns } from "../thread/queue/pending-turn-policy"

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

const gateways = [
  ExecutionGateway.StartTurnFailure,
  ExecutionGateway.CancelTurnFailure,
  ExecutionGateway.SteeringFailure,
  ExecutionGateway.WatchTurnFailure,
  ExecutionGateway.InspectTurnFailure,
]

export const makeFailure = (error: unknown): Failure => {
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

export const makeFailureFromError = makeFailure
