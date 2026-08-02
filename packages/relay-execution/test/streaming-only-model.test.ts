import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { AiError, LanguageModel, Response } from "effect/unstable/ai"
import { streamingOnlyLanguageModel } from "../src/streaming-only-model"

const usage = Response.Usage.make({
  inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})

const scriptedParts = (text: string) => [
  Response.makePart("text-start", { id: "part-1" }),
  Response.makePart("text-delta", { id: "part-1", delta: text.slice(0, Math.ceil(text.length / 2)) }),
  Response.makePart("text-delta", { id: "part-1", delta: text.slice(Math.ceil(text.length / 2)) }),
  Response.makePart("text-end", { id: "part-1" }),
  Response.makePart("finish", { reason: "stop", usage, response: undefined }),
]

const scriptedModel = (parts: ReadonlyArray<unknown>, calls: Array<string>): LanguageModel.Service =>
  ({
    generateText: () => {
      calls.push("generateText")
      return Effect.die("generateText must not be called on a streaming-only route")
    },
    generateObject: () => {
      calls.push("generateObject")
      return Effect.die("generateObject must not be called on a streaming-only route")
    },
    streamText: (options: { readonly prompt: unknown }) => {
      calls.push("streamText")
      calls.push(JSON.stringify(options.prompt))
      return Stream.fromIterable(parts as Iterable<never>)
    },
  }) as unknown as LanguageModel.Service

describe("streamingOnlyLanguageModel", () => {
  it.effect("aggregates streamed deltas into a generateText response", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const model = streamingOnlyLanguageModel(scriptedModel(scriptedParts("streamed answer"), calls))
      const response = yield* model.generateText({ prompt: "hello" })
      expect(response.text).toBe("streamed answer")
      expect(response.finishReason).toBe("stop")
      expect(calls.filter((call) => call === "streamText")).toHaveLength(1)
      expect(calls).not.toContain("generateText")
    }),
  )

  it.effect("decodes streamed JSON into a generateObject response", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const schema = Schema.Struct({ title: Schema.String, confident: Schema.Boolean })
      const model = streamingOnlyLanguageModel(
        scriptedModel(scriptedParts('{"title":"Recovered","confident":true}'), calls),
      )
      const response = yield* model.generateObject({ prompt: "hello", schema, objectName: "output" })
      expect(response.value).toEqual({ title: "Recovered", confident: true })
      expect(calls).not.toContain("generateObject")
      const instructed = calls.find((call) => call.includes("JSON"))
      expect(instructed).toBeDefined()
    }),
  )

  it.effect("decodes fenced JSON output leniently", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const schema = Schema.Struct({ ok: Schema.Boolean })
      const model = streamingOnlyLanguageModel(scriptedModel(scriptedParts('```json\n{"ok":true}\n```'), calls))
      const response = yield* model.generateObject({ prompt: "hello", schema })
      expect(response.value).toEqual({ ok: true })
    }),
  )

  it.effect("fails generateObject with a structured output error when no JSON decodes", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ ok: Schema.Boolean })
      const model = streamingOnlyLanguageModel(scriptedModel(scriptedParts("no json here"), []))
      const result = yield* model.generateObject({ prompt: "hello", schema }).pipe(Effect.flip)
      expect(String(result)).toContain("Structured output")
    }),
  )

  it.effect("keeps tool calls and reasoning in aggregated content", () =>
    Effect.gen(function* () {
      const parts = [
        Response.makePart("reasoning-start", { id: "r1" }),
        Response.makePart("reasoning-delta", { id: "r1", delta: "thinking" }),
        Response.makePart("reasoning-end", { id: "r1" }),
        Response.makePart("tool-call", {
          id: "call-1",
          name: "bash",
          params: { command: "ls" },
          providerExecuted: false,
        }),
        ...scriptedParts("done"),
      ]
      const model = streamingOnlyLanguageModel(scriptedModel(parts, []))
      const response = yield* model.generateText({ prompt: "hello" })
      expect(response.reasoningText).toBe("thinking")
      expect((response.toolCalls as Array<{ name: string }>).map((call) => call.name)).toEqual(["bash"])
      expect(response.text).toBe("done")
    }),
  )

  it.effect("fails generateText with the streamed provider error instead of dropping it", () =>
    Effect.gen(function* () {
      const overflow = AiError.make({
        module: "OpenAiClient",
        method: "createResponseStream",
        reason: AiError.InvalidRequestError.make({ description: "context length exceeded" }),
      })
      const parts = [Response.makePart("error", { error: overflow })]
      const model = streamingOnlyLanguageModel(scriptedModel(parts, []))
      const outcome = yield* Effect.flip(model.generateText({ prompt: "hello" }))
      expect(AiError.isAiError(outcome)).toBe(true)
      expect(String((outcome as { message: string }).message)).toContain("context length exceeded")
    }),
  )

  it.effect("fails generateObject with the streamed provider error instead of a decode failure", () =>
    Effect.gen(function* () {
      const parts = [Response.makePart("error", { error: "stream reset" })]
      const model = streamingOnlyLanguageModel(scriptedModel(parts, []))
      const outcome = yield* Effect.flip(
        model.generateObject({ prompt: "hello", schema: Schema.Struct({ ok: Schema.Boolean }), objectName: "output" }),
      )
      expect(AiError.isAiError(outcome)).toBe(true)
      expect(String((outcome as { message: string }).message)).toContain("stream reset")
    }),
  )
})
