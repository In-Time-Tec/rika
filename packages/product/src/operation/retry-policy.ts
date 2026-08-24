/**
 * The retry state machine for turns. A turn that settles failed with
 * `retry: "automatic"` is re-submitted with the same prompt, bounded attempts,
 * and Retry-After-aware exponential backoff — mirroring OpenCode's session
 * retry policy. Every retry decision and delay comes from here.
 */
import { Duration } from "effect"

export const turnRetryBudget = 3
export const turnRetryInitialDelayMillis = 2_000
export const turnRetryBackoffFactor = 2
export const turnRetryMaxDelayMillis = 30_000

export const turnRetryDelay = (input: {
  readonly attempt: number
  readonly retryAfterMillis?: number
}): Duration.Duration => {
  const retryAfterMillis = input.retryAfterMillis
  if (retryAfterMillis !== undefined && Number.isFinite(retryAfterMillis) && retryAfterMillis > 0)
    return Duration.millis(Math.min(retryAfterMillis, turnRetryMaxDelayMillis))
  const exponential = turnRetryInitialDelayMillis * Math.pow(turnRetryBackoffFactor, input.attempt - 1)
  return Duration.millis(Math.min(exponential, turnRetryMaxDelayMillis))
}

export const shouldRetryTurn = (input: {
  readonly retryable: boolean
  readonly retry: "automatic" | "none"
  readonly attempt: number
}): boolean => input.retryable && input.retry === "automatic" && input.attempt < turnRetryBudget
