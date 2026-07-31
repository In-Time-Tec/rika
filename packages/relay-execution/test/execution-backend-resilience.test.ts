import { describe, expect, it } from "@effect/vitest"

import { ModelResilience } from "@batonfx/core"

import { Effect, Fiber, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError } from "effect/unstable/ai"

import { fixture as testSupport } from "./execution-backend-fixture"
const { RelayExecutionBackend } = testSupport
describe("defaultModelResilience", () => {
  const retryableFailure = AiError.make({
    module: "OpenAiClient",
    method: "createResponseStream",
    reason: AiError.InvalidOutputError.make({ description: "boom" }),
  })
  it("classifies retryable model errors as transient and everything else as terminal", () => {
    expect(RelayExecutionBackend.defaultModelResilience.classify(retryableFailure)).toBe("transient")
    expect(RelayExecutionBackend.defaultModelResilience.classify(new Error("boom"))).toBe("terminal")
  })
  it.effect("retries a pre-emission retryable stream failure with backoff", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = {
        streamText: () =>
          Stream.unwrap(
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.map((attempt) => (attempt === 1 ? Stream.fail(retryableFailure) : Stream.make("part"))),
            ),
          ),
      }
      const resilient = ModelResilience.apply(
        model as never,
        RelayExecutionBackend.defaultModelResilience,
      ) as unknown as typeof model
      const fiber = yield* Stream.runCollect(resilient.streamText()).pipe(Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(fiber)).toEqual(["part"])
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )
  it.effect("does not retry terminal stream failures", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const failure = new Error("terminal")
      const model = {
        streamText: () =>
          Stream.unwrap(Ref.updateAndGet(attempts, (count) => count + 1).pipe(Effect.map(() => Stream.fail(failure)))),
      }
      const resilient = ModelResilience.apply(
        model as never,
        RelayExecutionBackend.defaultModelResilience,
      ) as unknown as typeof model
      const fiber = yield* Stream.runCollect(resilient.streamText()).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      expect(yield* Fiber.join(fiber)).toBe(failure)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
