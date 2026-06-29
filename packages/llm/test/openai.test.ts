import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { OpenAi, Provider, Retry } from "../src/index"

const request: Provider.GenerateRequest = {
  provider: "openai",
  model: "gpt-test",
  messages: [{ role: "user", content: "Hello" }],
  reasoning_effort: "low",
  max_output_tokens: 123,
  temperature: 0.2,
  metadata: { thread_id: "T-1" },
}

const aiError = (reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: "LanguageModel", method: "streamText", reason })

const rateLimitError = aiError(new AiError.RateLimitError({}))
const authError = aiError(new AiError.AuthenticationError({ kind: "InvalidKey" }))
const invalidOutputError = aiError(new AiError.InvalidOutputError({ description: "bad output" }))

describe("OpenAI Effect AI layer", () => {
  test("maps Rika routing data to Effect AI OpenAI request config", () => {
    expect(OpenAi.requestConfigFromRikaRequest(request)).toEqual({
      model: "gpt-test",
      store: false,
      temperature: 0.2,
      max_output_tokens: 123,
      metadata: { thread_id: "T-1" },
      reasoning: { effort: "low" },
    })
  })

  test("keeps OpenAI credentials behind the live layer options", () => {
    expect(OpenAi.defaultApiKeyEnv).toBe("OPENAI_API_KEY")
    expect(OpenAi.providerName).toBe("openai")
  })
})

describe("transient retry classification", () => {
  test("rate-limit AiErrors are retryable and transient", () => {
    expect(rateLimitError.isRetryable).toBe(true)
    expect(Retry.isTransient(rateLimitError)).toBe(true)
  })

  test("authentication AiErrors are not retryable and not transient", () => {
    expect(authError.isRetryable).toBe(false)
    expect(Retry.isTransient(authError)).toBe(false)
  })

  test("invalid-output AiErrors are retryable but never transient", () => {
    expect(invalidOutputError.isRetryable).toBe(true)
    expect(Retry.isTransient(invalidOutputError)).toBe(false)
  })

  test("non-AiError values are not transient", () => {
    expect(Retry.isTransient(new Error("boom"))).toBe(false)
  })
})

describe("retry middleware", () => {
  const success: ReadonlyArray<Provider.StreamEvent> = [
    { type: "response.started", provider: "openai", model: "gpt-test" },
    { type: "content.delta", text: "ok" },
    { type: "response.completed", response: { provider: "openai", model: "gpt-test", content: "ok" } },
  ]

  test("retries transient failures up to the bound then yields one clean sequence", async () => {
    let attempts = 0
    const stream: Stream.Stream<Provider.StreamEvent, Provider.ProviderError> = Stream.suspend(() => {
      attempts += 1
      return attempts < 3 ? Stream.fail(rateLimitError) : Stream.fromIterable(success)
    })

    const result = await Effect.runPromise(Retry.middleware(request)(stream).pipe(Stream.runCollect))

    expect(attempts).toBe(3)
    expect(Array.from(result).map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.completed",
    ])
  })

  test("does not retry non-transient failures", async () => {
    let attempts = 0
    const stream: Stream.Stream<Provider.StreamEvent, Provider.ProviderError> = Stream.suspend(() => {
      attempts += 1
      return Stream.fail(authError)
    })

    const exit = await Effect.runPromiseExit(Retry.middleware(request)(stream).pipe(Stream.runCollect))

    expect(attempts).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
