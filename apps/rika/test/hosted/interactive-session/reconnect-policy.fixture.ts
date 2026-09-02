import { expect, it } from "@effect/vitest"
import { HostedError } from "../../../src/hosted/contract"
import { reconnectDelay, retryableConnectionFailure } from "../../../src/hosted/reconnect-policy"

it("backs transient connection failures off to five seconds", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelay({ attempt }))).toEqual([
    250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
  ])
})

it("honors a larger server retry delay without exceeding one minute", () => {
  expect(reconnectDelay({ attempt: 0, retryAfterMillis: 42_000 })).toBe(42_000)
  expect(reconnectDelay({ attempt: 6, retryAfterMillis: 90_000 })).toBe(60_000)
})

it("retries only network and rate-limit failures", () => {
  expect(retryableConnectionFailure(HostedError.make({ kind: "network", message: "closed" }))).toBe(true)
  expect(retryableConnectionFailure(HostedError.make({ kind: "rate-limit", message: "limited" }))).toBe(true)
  expect(retryableConnectionFailure(HostedError.make({ kind: "login-required", message: "login" }))).toBe(false)
  expect(retryableConnectionFailure(HostedError.make({ kind: "protocol", message: "invalid frame" }))).toBe(false)
})
