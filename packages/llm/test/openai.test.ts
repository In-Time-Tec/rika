import { OpenAiClient } from "@effect/ai-openai"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { OpenAi, Provider, Retry } from "../src/index"

const request: Provider.GenerateRequest = {
  provider: "openai",
  model: "gpt-test",
  messages: [{ role: "user", content: "Hello" }],
  reasoning_effort: "low",
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
      reasoning: { effort: "low" },
    })
  })

  test("omits OpenAI metadata while response storage is disabled", () => {
    expect(OpenAi.requestConfigFromRikaRequest(request)).not.toHaveProperty("metadata")
  })

  test("forwards a priority service tier when fast mode resolved it", () => {
    expect(OpenAi.requestConfigFromRikaRequest({ ...request, service_tier: "priority" })).toEqual({
      model: "gpt-test",
      store: false,
      temperature: 0.2,
      reasoning: { effort: "low" },
      service_tier: "priority",
    })
  })

  test("omits service_tier when none was resolved", () => {
    expect(OpenAi.requestConfigFromRikaRequest(request)).not.toHaveProperty("service_tier")
  })

  test("keeps OpenAI credentials behind the live layer options", () => {
    expect(OpenAi.defaultApiKeyEnv).toBe("RIKA_API_KEY")
    expect(OpenAi.providerName).toBe("openai")
  })

  test("serializes image file parts as OpenAI input images", async () => {
    let captured: unknown
    const stopAfterCapture = aiError(new AiError.InvalidRequestError({ description: "stop after capture" }))
    const fakeClientLayer = Layer.succeed(
      OpenAiClient.OpenAiClient,
      OpenAiClient.OpenAiClient.of({
        get client(): never {
          throw new Error("unused")
        },
        createResponse: (options) => {
          captured = options
          return Effect.fail(stopAfterCapture)
        },
        createResponseStream: (options) => {
          captured = options
          return Effect.fail(stopAfterCapture)
        },
        createEmbedding: () => Effect.fail(stopAfterCapture),
      }),
    )

    await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.complete({
          provider: "openai",
          model: "gpt-4.1",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Look at " },
                { type: "file", media_type: "image/png", data: "cG5n", filename: "shot.png" },
                { type: "text", text: " please" },
              ],
            },
          ],
        })
      }).pipe(
        Effect.provide(Provider.layer()),
        Effect.provide(OpenAi.languageModelLayer({ model: "gpt-4.1" })),
        Effect.provide(fakeClientLayer),
      ),
    )

    expect(captured).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Look at " },
            { type: "input_image", image_url: "data:image/png;base64,cG5n", detail: "auto" },
            { type: "input_text", text: " please" },
          ],
        },
      ],
    })
  })
})

describe("OpenAI Responses [DONE] SSE compatibility", () => {
  test("drops a trailing data: [DONE] sentinel while keeping event lines", () => {
    const out = OpenAi.withoutDoneLines('data: {"a":1}\n\ndata: [DONE]\n\n')
    expect(out).not.toContain("[DONE]")
    expect(out).toContain('data: {"a":1}')
  })

  test("drops data:[DONE] without a space", () => {
    expect(OpenAi.withoutDoneLines("data:[DONE]\n")).not.toContain("[DONE]")
  })

  test("leaves a stream without a sentinel unchanged", () => {
    const input = 'data: {"a":1}\n\ndata: {"b":2}\n\n'
    expect(OpenAi.withoutDoneLines(input)).toBe(input)
  })

  test("keeps legitimate data whose JSON payload merely contains [DONE]", () => {
    const input = 'data: {"text":"[DONE]"}\n'
    expect(OpenAi.withoutDoneLines(input)).toBe(input)
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
