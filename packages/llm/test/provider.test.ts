import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Model, Response, Tool, Toolkit } from "effect/unstable/ai"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import { Provider } from "../src/index"

const request: Provider.GenerateRequest = {
  provider: "openai",
  model: "model-test",
  messages: [{ role: "user", content: "Hello" }],
}

const FakeEcho = Tool.dynamic("fake_echo", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Json,
})
const FakeEchoToolkit = Toolkit.make(FakeEcho)

describe("LLM Provider", () => {
  test("fake layer returns deterministic responses through the provider interface", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const first = yield* provider.complete(request)
        const second = yield* provider.complete(request)
        return { first, second }
      }).pipe(Effect.provide(Provider.fakeLayer(["one", "two"]))),
    )

    expect(result.first).toMatchObject({ provider: "openai", model: "model-test", content: "one" })
    expect(result.second).toMatchObject({ provider: "openai", model: "model-test", content: "two" })
  })

  test("fake stream normalizes complete responses into stream events", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.stream(request).pipe(Stream.runCollect)
      }).pipe(Effect.provide(Provider.fakeLayer(["streamed"]))),
    )

    expect(Array.from(result)).toEqual([
      { type: "response.started", provider: "openai", model: "model-test" },
      { type: "content.delta", text: "streamed" },
      {
        type: "response.completed",
        response: { provider: "openai", model: "model-test", content: "streamed", finish_reason: "stop" },
      },
    ])
  })

  test("maps Effect AI tool parameter parts to typed tool stream events", async () => {
    let handled = 0
    const fakeEchoToolkit = Effect.provide(
      FakeEchoToolkit,
      FakeEchoToolkit.toLayer(
        FakeEchoToolkit.of({
          fake_echo: () =>
            Effect.sync(() => {
              handled += 1
              return null
            }),
        }),
      ),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider
          .stream({
            ...request,
            toolkit: fakeEchoToolkit,
          })
          .pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(
          Provider.fakeLayer([
            {
              type: "tool-call",
              id: "call_fake_echo",
              name: "fake_echo",
              input: { text: "hello" },
              input_text: '{"text":"hello"}',
            },
          ]),
        ),
      ),
    )

    expect(Array.from(result)).toEqual([
      { type: "response.started", provider: "openai", model: "model-test" },
      { type: "tool.input.started", id: "call_fake_echo", name: "fake_echo" },
      { type: "tool.input.delta", id: "call_fake_echo", text: '{"text":"hello"}' },
      { type: "tool.input.ended", id: "call_fake_echo", name: "fake_echo", input_text: '{"text":"hello"}' },
      { type: "tool.call", id: "call_fake_echo", name: "fake_echo", input: { text: "hello" } },
      {
        type: "response.completed",
        response: { provider: "openai", model: "model-test", content: "", finish_reason: "tool-call" },
      },
    ])
    expect(handled).toBe(0)
  })

  test("anthropic toolkit adaptation keeps optional tool fields optional on the wire", async () => {
    const ToolWithOptionalFields = Tool.make("tool_with_optional_fields", {
      parameters: Schema.Struct({
        required: Schema.String,
        optional_number: Schema.optionalKey(Schema.Int),
      }).annotate({ identifier: "Rika.LLM.Test.ToolWithOptionalFields" }),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const OriginalToolkit = Toolkit.make(ToolWithOptionalFields)
    const originalToolkit = Effect.provide(
      OriginalToolkit,
      OriginalToolkit.toLayer(OriginalToolkit.of({ tool_with_optional_fields: () => Effect.succeed(null) })),
    )
    const adaptedToolkit = Provider.toolkitForProvider("anthropic", originalToolkit)
    if (adaptedToolkit === undefined || !Effect.isEffect(adaptedToolkit)) {
      throw new Error("Anthropic toolkit was not adapted")
    }

    const originalSchema = Tool.getJsonSchema(ToolWithOptionalFields, { transformer: toCodecAnthropic })
    const adapted = await Effect.runPromise(adaptedToolkit)
    const adaptedTool = adapted.tools.tool_with_optional_fields
    const adaptedSchema = Tool.getJsonSchema(adaptedTool, { transformer: toCodecAnthropic })

    expect(adaptedTool.parametersSchema).toBe(ToolWithOptionalFields.parametersSchema)
    expect(() => toCodecAnthropic(adaptedTool.parametersSchema)).not.toThrow()
    expect(() => toCodecAnthropic(adaptedTool.successSchema)).not.toThrow()
    expect(() => toCodecAnthropic(adaptedTool.failureSchema)).not.toThrow()
    expect(countUnionNodes(originalSchema)).toBeGreaterThan(0)
    expect(countUnionNodes(adaptedSchema)).toBe(0)
    expect(countOptionalProperties(adaptedSchema)).toBe(0)
    expect(adaptedSchema).toMatchObject({
      type: "object",
      properties: {
        required: { type: "string" },
      },
      required: ["required"],
      additionalProperties: false,
    })
    expect(Object.keys(adaptedSchema.properties ?? {})).not.toContain("optional_number")

    const EmptyTool = Tool.make("empty_tool", {
      parameters: Tool.EmptyParams,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    expect(Tool.getJsonSchema(Provider.anthropicWireTool(EmptyTool), { transformer: toCodecAnthropic })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })

    const DynamicJsonTool = Tool.dynamic("dynamic_json_tool", {
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const adaptedDynamicTool = Provider.anthropicWireTool(DynamicJsonTool)

    expect(() => toCodecAnthropic(adaptedDynamicTool.parametersSchema)).not.toThrow()
    expect(() => toCodecAnthropic(adaptedDynamicTool.successSchema)).not.toThrow()
    expect(() => toCodecAnthropic(adaptedDynamicTool.failureSchema)).not.toThrow()
    expect(Tool.getJsonSchema(adaptedDynamicTool, { transformer: toCodecAnthropic })).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    })
  })

  test("salvages a mid-stream InvalidOutputError into one completed response", async () => {
    const failure = AiError.make({
      module: "LanguageModel",
      method: "streamText",
      reason: new AiError.InvalidOutputError({ description: "unexpected image_generation tool-call part" }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.stream(request).pipe(Stream.runCollect)
      }).pipe(Effect.provide(Provider.fakeLayer(["partial answer"], { failStreamWith: failure }))),
    )

    expect(Array.from(result)).toEqual([
      { type: "response.started", provider: "openai", model: "model-test" },
      { type: "content.delta", text: "partial answer" },
      {
        type: "response.completed",
        response: { provider: "openai", model: "model-test", content: "partial answer", finish_reason: "stop" },
      },
    ])
  })

  test("propagates stream failures after tool protocol starts", async () => {
    const failure = AiError.make({
      module: "LanguageModel",
      method: "streamText",
      reason: new AiError.InvalidOutputError({ description: "tool stream failed" }),
    })
    const streamParts: ReadonlyArray<Response.StreamPartEncoded> = [
      { type: "tool-params-start", id: "call_fake_echo", name: "fake_echo" },
      { type: "tool-params-delta", id: "call_fake_echo", delta: '{"text":"hello"}' },
    ]
    const languageModelLayer = Layer.mergeAll(
      Layer.succeed(Model.ProviderName, "openai"),
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.fail(failure),
          streamText: () => Stream.fromIterable(streamParts).pipe(Stream.concat(Stream.fail(failure))),
        }),
      ),
    )

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider
          .stream({
            ...request,
            toolkit: Effect.provide(
              FakeEchoToolkit,
              FakeEchoToolkit.toLayer(FakeEchoToolkit.of({ fake_echo: () => Effect.succeed(null) })),
            ),
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(Provider.layer()), Effect.provide(languageModelLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("provider layers can be replaced with a named fake", async () => {
    const layer = Provider.fakeLayer(["nope"], { name: "fake-provider" })
    const name = await Effect.runPromise(
      Effect.map(Provider.Service, (provider) => provider.name).pipe(Effect.provide(layer)),
    )

    expect(name).toBe("fake-provider")
  })

  test("fake layer state is scoped to a layer instance", async () => {
    const firstLayer = Provider.fakeLayer(["a", "b"])
    const secondLayer = Provider.fakeLayer(["a", "b"])
    const complete = Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.complete(request)
    })

    const [first, second] = await Effect.runPromise(
      Effect.all([complete.pipe(Effect.provide(firstLayer)), complete.pipe(Effect.provide(secondLayer))]),
    )

    expect(first.content).toBe("a")
    expect(second.content).toBe("a")
  })

  test("fake layer can be composed like any other Effect layer", async () => {
    const combined = Layer.mergeAll(Provider.fakeLayer(["ok"]))
    const result = await Effect.runPromise(Provider.Service.pipe(Effect.provide(combined)))

    expect(result.name).toBe("openai")
  })

  test("fake language model layer satisfies Effect AI directly", async () => {
    const response = await Effect.runPromise(
      LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(Provider.fakeLanguageModelLayer(["effect ai"])),
      ),
    )

    expect(response.text).toBe("effect ai")
    expect(response.finishReason).toBe("stop")
  })

  test("converts Rika messages to Effect AI prompt input", () => {
    expect(
      Provider.promptFromMessages([
        { role: "developer", content: "Follow repository guidance." },
        { role: "user", content: "Ship it." },
        { role: "tool", content: "Tool output" },
      ]),
    ).toEqual([
      { role: "system", content: "Follow repository guidance." },
      { role: "user", content: "Ship it." },
      { role: "user", content: "Tool output" },
    ])
  })

  test("converts structured image message content to Effect AI file parts", () => {
    expect(
      Provider.promptFromMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "Look at " },
            { type: "file", media_type: "image/png", data: "cG5n", filename: "shot.png" },
            { type: "text", text: " please" },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at " },
          { type: "file", mediaType: "image/png", fileName: "shot.png", data: Buffer.from("png") },
          { type: "text", text: " please" },
        ],
      },
    ])
  })

  test("sanitizes empty text prompt blocks before provider serialization", () => {
    const sanitized = Provider.sanitizePromptInput([
      { role: "system", content: "   " },
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "keep" },
        ],
      },
      { role: "assistant", content: " \n\t " },
      {
        role: "assistant",
        content: [
          { type: "text", text: " \n" },
          { type: "tool-call", id: "call_1", name: "read", params: { path: "README.md" }, providerExecuted: false },
        ],
      },
    ])

    expect(sanitized.content.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(sanitized.content[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "keep" }],
    })
    expect(sanitized.content[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", id: "call_1", name: "read" }],
    })
  })
})

const countUnionNodes = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countUnionNodes(item), 0)
  if (value === null || typeof value !== "object") return 0
  const self =
    ("anyOf" in value && Array.isArray(value.anyOf)) || ("type" in value && Array.isArray(value.type)) ? 1 : 0
  return self + Object.values(value).reduce((count, item) => count + countUnionNodes(item), 0)
}

const countOptionalProperties = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countOptionalProperties(item), 0)
  if (value === null || typeof value !== "object") return 0
  const required = "required" in value && Array.isArray(value.required) ? new Set(value.required) : new Set()
  const properties = "properties" in value && isObject(value.properties) ? value.properties : undefined
  const self = properties === undefined ? 0 : Object.keys(properties).filter((name) => !required.has(name)).length
  return self + Object.values(value).reduce((count, item) => count + countOptionalProperties(item), 0)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
