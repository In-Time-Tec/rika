import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
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
const fakeEchoToolkit = Effect.provide(
  FakeEchoToolkit,
  FakeEchoToolkit.toLayer(FakeEchoToolkit.of({ fake_echo: () => Effect.succeed(null) })),
)

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
      { type: "tool.result", id: "call_fake_echo", name: "fake_echo", result: null, is_failure: false },
      {
        type: "response.completed",
        response: { provider: "openai", model: "model-test", content: "", finish_reason: "tool-call" },
      },
    ])
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
})
