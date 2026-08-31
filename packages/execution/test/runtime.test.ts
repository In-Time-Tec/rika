import { describe, expect, it } from "@effect/vitest"
import { Chat, LanguageModel } from "effect/unstable/ai"
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ModelRegistry } from "generalist"
import * as OpenRouter from "generalist/ai/openrouter"

const captured: Array<{ readonly url: string; readonly body: string }> = []
const ChatRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String })),
  input: Schema.optionalKey(Schema.Unknown),
  previous_response_id: Schema.optionalKey(Schema.Unknown),
})

let reply = 0
const cannedResponse = () => {
  reply += 1
  return {
    id: `gen-${reply}`,
    object: "chat.completion",
    created: 0,
    model: "deepseek/deepseek-v4-flash-0731",
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: reply === 1 ? "Hi there!" : "I am fine." },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

const mockHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const body = Schema.decodeUnknownOption(Schema.TaggedStruct("Uint8Array", { body: Schema.Uint8Array }))(
      request.body,
    )
    const text = body._tag === "Some" ? new TextDecoder().decode(body.value.body) : ""
    captured.push({ url: request.url, body: text })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new globalThis.Response(JSON.stringify(cannedResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  }),
)

const layer = Layer.unwrap(
  OpenRouter.decodeConfig({ reasoning: { effort: "low", summary: "auto" } }).pipe(
    Effect.map((config) =>
      OpenRouter.layer({
        model: "~deepseek/deepseek-v4-flash-latest",
        config,
        apiKey: Config.succeed(Redacted.make("sk-or-v1-test")),
        clientConfig: { apiUrl: Config.succeed("https://openrouter.ai/api/v1") },
      }),
    ),
  ),
).pipe(Layer.provide(mockHttp))

describe("OpenRouter provider conversation continuity", () => {
  it.effect("sends the second turn as chat completions with full message history and no item ids", () =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) =>
        Effect.gen(function* () {
          const model = yield* ModelRegistry.withModel(
            { provider: "openrouter", model: "~deepseek/deepseek-v4-flash-latest" },
            Effect.service(LanguageModel.LanguageModel),
          ).pipe(Effect.provideService(ModelRegistry.ModelRegistry, Context.get(context, ModelRegistry.ModelRegistry)))
          const chat = yield* Chat.fromPrompt([{ role: "system", content: "You are a helpful assistant." }])
          const withModel = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(Effect.provideService(LanguageModel.LanguageModel, model))

          yield* withModel(chat.generateText({ prompt: "Hi" }))
          captured.length = 0
          yield* withModel(chat.generateText({ prompt: "How are you?" }))

          expect(captured.length).toBe(1)
          const second = captured[0]!
          expect(second.url).toBe("https://openrouter.ai/api/v1/chat/completions")
          const body = yield* Schema.decodeEffect(Schema.fromJsonString(ChatRequest))(second.body)
          expect(body.input).toBeUndefined()
          expect(body.previous_response_id).toBeUndefined()
          expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"])
          expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).not.toContain('"id":null')
        }).pipe(Effect.provide(context)),
      ),
    ),
  )
})
