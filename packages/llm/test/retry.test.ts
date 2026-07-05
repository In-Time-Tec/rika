import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Random, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AiError } from "effect/unstable/ai"
import { Provider, Retry } from "../src/index"

const request: Provider.GenerateRequest = {
  provider: "openai",
  model: "gpt-test",
  messages: [{ role: "user", content: "Hello" }],
}

const response: Provider.GenerateResponse = {
  provider: "openai",
  model: "gpt-test",
  content: "ok",
}

const aiError = (reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: "LanguageModel", method: "generateText", reason })

const rateLimitError = aiError(new AiError.RateLimitError({}))
const retryAfterError = aiError(new AiError.RateLimitError({ retryAfter: Duration.seconds(5) }))

const midpointRandom = {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0.5,
}

describe("LLM retry middleware", () => {
  test("complete retries transient failures with deterministic backoff and succeeds", async () => {
    let attempts = 0
    const completion: Effect.Effect<Provider.GenerateResponse, Provider.ProviderError> = Effect.gen(function* () {
      attempts += 1
      if (attempts < 3) return yield* Effect.fail(rateLimitError)
      return response
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Retry.completeMiddleware(request)(completion).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("249 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("1 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(2)
          yield* TestClock.adjust("499 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(2)
          yield* TestClock.adjust("1 millis")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Random.Random, midpointRandom)),
    )

    expect(result).toEqual(response)
    expect(attempts).toBe(3)
  })

  test("completeStructured retries transient failures up to the retry bound", async () => {
    const Decision = Schema.Struct({ answer: Schema.String })
    let attempts = 0
    const completion: Effect.Effect<
      Provider.StructuredResponse<typeof Decision.Type>,
      Provider.ProviderError
    > = Effect.gen(function* () {
      attempts += 1
      return yield* Effect.fail(rateLimitError)
    })

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Retry.completeStructuredMiddleware({ ...request, schema: Decision })(completion).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("250 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(2)
          yield* TestClock.adjust("500 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(3)
          yield* TestClock.adjust("1 second")
          const cause = yield* Fiber.join(fiber).pipe(Effect.flip)
          return cause
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Random.Random, midpointRandom)),
    )

    expect(error).toBe(rateLimitError)
    expect(attempts).toBe(4)
  })

  test("retryAfter overrides the default exponential delay", async () => {
    let attempts = 0
    const completion: Effect.Effect<Provider.GenerateResponse, Provider.ProviderError> = Effect.gen(function* () {
      attempts += 1
      if (attempts === 1) return yield* Effect.fail(retryAfterError)
      return response
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Retry.completeMiddleware(request)(completion).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("4999 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("1 millis")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Random.Random, midpointRandom)),
    )

    expect(result).toEqual(response)
    expect(attempts).toBe(2)
  })
})
