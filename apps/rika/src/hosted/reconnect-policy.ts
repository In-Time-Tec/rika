import type { HostedError } from "./contract"

export const retryableConnectionFailure = (error: HostedError) =>
  error.kind === "network" || error.kind === "rate-limit"

export const reconnectDelay = (input: { readonly attempt: number; readonly retryAfterMillis?: number }) => {
  const backoff = Math.min(250 * 2 ** Math.min(input.attempt, 5), 5_000)
  return Math.min(Math.max(backoff, input.retryAfterMillis ?? 0), 60_000)
}
