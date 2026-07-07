import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { Effect, Layer, Schema, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { Provider, Router } from "../src/index"

const configLayer = Config.layerFromValues(
  {
    workspace_root: "/workspace",
    data_dir: "/workspace/.rika",
    default_mode: "smart",
  },
  {},
)

const messages: ReadonlyArray<Provider.Message> = [{ role: "user", content: "ship it" }]

const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(SecretRedactor.layer))

const routerLayerFrom = (registryLayer: Layer.Layer<Provider.Registry>) =>
  Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(diagnosticsLayer),
  )

const routerLayer = routerLayerFrom(
  Provider.fakeRegistryLayer([
    { name: "openai", responses: ["done"] },
    { name: "anthropic", responses: ["done"] },
  ]),
)

describe("LLM Router", () => {
  test("routes default requests through the configured default mode", async () => {
    const routed = await Effect.runPromise(Router.route({ messages }).pipe(Effect.provide(routerLayer)))

    expect(routed).toMatchObject({
      mode: "smart",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning_effort: "max",
      messages,
    })
  })

  test("lets callers override mode, provider, model, and reasoning", async () => {
    const routed = await Effect.runPromise(
      Router.route({
        mode: "deep3",
        provider: "openai",
        model: "custom-model",
        messages,
        reasoning_effort: "xhigh",
        temperature: 0.1,
      }).pipe(Effect.provide(routerLayer)),
    )

    expect(routed).toMatchObject({
      mode: "deep3",
      provider: "openai",
      model: "custom-model",
      reasoning_effort: "xhigh",
      temperature: 0.1,
    })
  })

  test("resolves fast mode to the priority service tier for OpenAI modes", async () => {
    for (const mode of ["rush", "deep1", "deep2", "deep3"] as const) {
      const routed = await Effect.runPromise(
        Router.route({ mode, messages, fast_mode: true }).pipe(Effect.provide(routerLayer)),
      )
      expect(routed).toMatchObject({ provider: "openai", service_tier: "priority" })
    }
  })

  test("does not set a service tier for non-OpenAI modes or when fast mode is off", async () => {
    const smart = await Effect.runPromise(
      Router.route({ mode: "smart", messages, fast_mode: true }).pipe(Effect.provide(routerLayer)),
    )
    expect(smart).not.toHaveProperty("service_tier")

    const deepStandard = await Effect.runPromise(
      Router.route({ mode: "deep2", messages }).pipe(Effect.provide(routerLayer)),
    )
    expect(deepStandard).not.toHaveProperty("service_tier")
  })

  test("routes compaction profile through a cheap dedicated OpenAI model", async () => {
    const routed = await Effect.runPromise(
      Router.route({ profile: "compaction", messages }).pipe(Effect.provide(routerLayer)),
    )

    expect(routed).toMatchObject({
      mode: "smart",
      profile: "compaction",
      provider: "openai",
      model: "gpt-5.5",
      reasoning_effort: "low",
      messages,
    })
  })

  test("complete depends only on the router service and fake provider layer", async () => {
    const response = await Effect.runPromise(
      Router.complete({ mode: "rush", messages }).pipe(Effect.provide(routerLayer)),
    )

    expect(response).toMatchObject({ provider: "openai", model: "gpt-5.5", content: "done" })
  })

  test("completeStructured decodes valid JSON and returns the raw response", async () => {
    const Decision = Schema.Struct({ answer: Schema.String, score: Schema.Number })
    const layer = routerLayerFrom(
      Provider.fakeRegistryLayer([{ name: "openai", responses: ['{"answer":"ship","score":1}'] }]),
    )

    const result = await Effect.runPromise(
      Router.completeStructured({ mode: "rush", messages, schema: Decision }).pipe(Effect.provide(layer)),
    )

    expect(result.value).toEqual({ answer: "ship", score: 1 })
    expect(result.raw).toMatchObject({ provider: "openai", model: "gpt-5.5", content: '{"answer":"ship","score":1}' })
  })

  test("completeStructured retries once after invalid JSON and decodes the correction", async () => {
    const Decision = Schema.Struct({ answer: Schema.String, score: Schema.Number })
    const layer = routerLayerFrom(
      Provider.fakeRegistryLayer([{ name: "openai", responses: ["not json", '{"answer":"corrected","score":2}'] }]),
    )

    const result = await Effect.runPromise(
      Router.completeStructured({ mode: "rush", messages, schema: Decision }).pipe(Effect.provide(layer)),
    )

    expect(result.value).toEqual({ answer: "corrected", score: 2 })
    expect(result.raw.content).toBe('{"answer":"corrected","score":2}')
  })

  test("completeStructured prompt fallback preserves the prompt with schema and correction messages", async () => {
    const Decision = Schema.Struct({ answer: Schema.String })
    const prompts: Array<string> = []
    const unsupportedStructuredOutput = AiError.make({
      module: "LanguageModel",
      method: "generateObject",
      reason: new AiError.UnsupportedSchemaError({ description: "unsupported in test" }),
    })
    const provider: Provider.Interface = {
      name: "openai",
      complete: (request) =>
        Effect.sync(() => {
          prompts.push(JSON.stringify(request.prompt ?? request.messages))
          return {
            provider: "openai",
            model: request.model,
            content: prompts.length === 1 ? "not json" : '{"answer":"corrected"}',
          }
        }),
      completeStructured: () => Effect.fail(unsupportedStructuredOutput),
      stream: () => Stream.empty,
    }
    const layer = routerLayerFrom(Provider.registryLayerFromProviders([provider]))

    const result = await Effect.runPromise(
      Router.completeStructured({ mode: "rush", messages: [], prompt: "ship it", schema: Decision }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result.value).toEqual({ answer: "corrected" })
    expect(prompts[0]).toContain("ship it")
    expect(prompts[0]).toContain("Return only JSON matching this JSON Schema.")
    expect(prompts[1]).toContain("The previous response did not match the required schema")
  })

  test("completeStructured decodes fenced JSON", async () => {
    const Decision = Schema.Struct({ answer: Schema.String })
    const layer = routerLayerFrom(
      Provider.fakeRegistryLayer([{ name: "openai", responses: ['```json\n{"answer":"ok"}\n```'] }]),
    )

    const result = await Effect.runPromise(
      Router.completeStructured({ mode: "rush", messages, schema: Decision }).pipe(Effect.provide(layer)),
    )

    expect(result.value).toEqual({ answer: "ok" })
  })

  test("completeStructured uses the provider structured path before text fallback", async () => {
    const Decision = Schema.Struct({ answer: Schema.String })
    const provider: Provider.Interface = {
      name: "openai",
      complete: () => Effect.die(new Error("plain completion should not run")),
      completeStructured: (request) =>
        Effect.succeed({
          value: Schema.decodeUnknownSync(request.schema)({ answer: "native" }),
          raw: { provider: "openai", model: request.model, content: '{"answer":"native"}' },
        }),
      stream: () => Stream.empty,
    }
    const layer = routerLayerFrom(Provider.registryLayerFromProviders([provider]))

    const result = await Effect.runPromise(
      Router.completeStructured({ mode: "rush", messages, schema: Decision }).pipe(Effect.provide(layer)),
    )

    expect(result.value).toEqual({ answer: "native" })
  })

  test("completeStructured fails with a typed error after retries are exhausted", async () => {
    const Decision = Schema.Struct({ answer: Schema.String })
    const error = await Effect.runPromise(
      Router.completeStructured({ mode: "rush", messages, schema: Decision, retries: 0 }).pipe(
        Effect.provide(
          Router.layer.pipe(
            Layer.provideMerge(configLayer),
            Layer.provideMerge(Provider.fakeRegistryLayer([{ name: "openai", responses: ["not json"] }])),
            Layer.provideMerge(diagnosticsLayer),
          ),
        ),
        Effect.flip,
      ),
    )

    expect(error).toBeInstanceOf(Router.StructuredOutputError)
    expect(error).toMatchObject({
      raw_content: "not json",
      _tag: "StructuredOutputError",
    })
  })

  test("stream emits normalized provider stream events", async () => {
    const events = await Effect.runPromise(
      Router.stream({ messages }).pipe(Stream.runCollect, Effect.provide(routerLayer)),
    )

    expect(Array.from(events).map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.completed",
    ])
  })

  test("fails explicitly when routed provider does not match the provided layer", async () => {
    const result = await Effect.runPromiseExit(
      Router.complete({ provider: "other", messages }).pipe(Effect.provide(routerLayer)),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.toString()).toContain("other")
    }
  })
})
