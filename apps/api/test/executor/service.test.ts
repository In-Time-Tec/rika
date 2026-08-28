import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ExecutorConfigError, loadConfig, makeOrphanReaper } from "../../src/executor/service"

const environment = {
  E2B_API_KEY: "e2b-api-key",
  E2B_APP_ID: "rika",
  E2B_DEPLOYMENT_ID: "deployment-1",
  E2B_TEMPLATE_ID: "ar7-template-alias",
  E2B_TEMPLATE_BUILD_ID: "7d0-build-receipt",
  RIKA_EXECUTOR_API_URL: "wss://api.example.test/api/v1/executors",
  RIKA_WORKSPACE_CHECKPOINT_BUCKET: "rika-checkpoints",
  RIKA_WORKSPACE_CHECKPOINT_REGION: "us-east-1",
  RIKA_WORKSPACE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
}

describe("executor configuration", () => {
  it.effect("requires the E2B template ID separately from the immutable build receipt", () =>
    Effect.gen(function* () {
      const configured = yield* loadConfig(environment)
      expect(configured).toMatchObject({
        templateId: "ar7-template-alias",
        templateBuildId: "7d0-build-receipt",
        apiUrl: "wss://api.example.test/api/v1/executors",
        controlEgress: ["api.example.test"],
      })
      expect(Redacted.value(configured.apiKey)).toBe("e2b-api-key")
      expect(Redacted.value(configured.checkpointKey)).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
      const templateError = yield* loadConfig({ ...environment, E2B_TEMPLATE_ID: "" }).pipe(Effect.flip)
      const apiError = yield* loadConfig({ ...environment, RIKA_EXECUTOR_API_URL: "" }).pipe(Effect.flip)
      expect(Schema.is(ExecutorConfigError)(templateError)).toBe(true)
      expect(templateError.message).toBe("E2B_TEMPLATE_ID is required")
      expect(Schema.is(ExecutorConfigError)(apiError)).toBe(true)
      expect(apiError.message).toBe("RIKA_EXECUTOR_API_URL is required")
    }),
  )
})

describe("executor orphan reaper", () => {
  it.effect("keeps readiness checks separate from one recurring cleanup", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const reaper = makeOrphanReaper(Ref.update(calls, (count) => count + 1), "5 minutes")
      const running = yield* reaper.run.pipe(Effect.forkChild({ startImmediately: true }))

      yield* reaper.check
      yield* reaper.check
      expect(yield* Ref.get(calls)).toBe(2)

      yield* TestClock.adjust("5 minutes")
      expect(yield* Ref.get(calls)).toBe(3)
      yield* TestClock.adjust("5 minutes")
      expect(yield* Ref.get(calls)).toBe(4)

      yield* Fiber.interrupt(running)
    }),
  )
})
