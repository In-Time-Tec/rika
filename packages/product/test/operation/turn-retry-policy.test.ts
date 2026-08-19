import { describe, expect, it } from "@effect/vitest"
import { Duration } from "effect"
import { shouldRetryTurn, turnRetryBudget, turnRetryDelay } from "../../src/operation/turn-retry-policy"

describe("turn retry policy", () => {
  it("retries only automatic retryable failures within the budget", () => {
    expect(shouldRetryTurn({ retryable: true, retry: "automatic", attempt: 1 })).toBe(true)
    expect(shouldRetryTurn({ retryable: true, retry: "automatic", attempt: turnRetryBudget })).toBe(false)
    expect(shouldRetryTurn({ retryable: false, retry: "automatic", attempt: 1 })).toBe(false)
    expect(shouldRetryTurn({ retryable: true, retry: "none", attempt: 1 })).toBe(false)
  })

  it("backs off exponentially with a cap", () => {
    expect(Duration.toMillis(turnRetryDelay({ attempt: 1 }))).toBe(2_000)
    expect(Duration.toMillis(turnRetryDelay({ attempt: 2 }))).toBe(4_000)
    expect(Duration.toMillis(turnRetryDelay({ attempt: 3 }))).toBe(8_000)
    expect(Duration.toMillis(turnRetryDelay({ attempt: 10 }))).toBe(30_000)
  })

  it("honors a provider retry-after hint within the cap", () => {
    expect(Duration.toMillis(turnRetryDelay({ attempt: 1, retryAfterMillis: 500 }))).toBe(500)
    expect(Duration.toMillis(turnRetryDelay({ attempt: 1, retryAfterMillis: 60_000 }))).toBe(30_000)
    expect(Duration.toMillis(turnRetryDelay({ attempt: 1, retryAfterMillis: -1 }))).toBe(2_000)
  })
})
