import { expect, it } from "@effect/vitest"
import * as Anthropic from "generalist/ai/anthropic"
import * as OpenAiResponses from "generalist/ai/openai-responses"
import * as Settings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import { Chat, LanguageModel } from "effect/unstable/ai"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ModelRegistry } from "generalist"

const decoders = { "openai-responses": OpenAiResponses.decodeConfig, anthropic: Anthropic.decodeConfig } as const

const efforts = ["low", "medium", "high", "xhigh", "max"] as const
const AnthropicOptions = Schema.Struct({ output_config: Schema.Struct({ effort: Schema.String }) })
const OpenAiOptions = Schema.Struct({ reasoning: Schema.Struct({ effort: Schema.String }) })

const settingsFor = (alias: string, effort: (typeof efforts)[number]): Settings.ConfigurationSettings => ({
  ...Settings.Defaults.settingsDefaults,
  modes: {
    ...Settings.Defaults.settingsDefaults.modes,
    medium: {
      main: { alias, effort },
      oracle: { alias, effort },
      agents: Settings.Defaults.settingsDefaults.modes.medium!.agents,
    },
  },
})

const routedOptions = (alias: string, effort: (typeof efforts)[number]) =>
  ExecutionRouteResolution.resolve(settingsFor(alias, effort), "medium").main.candidates[0]!.providerOptions

const anthropicEffort = (alias: string, effort: (typeof efforts)[number]) =>
  Schema.decodeUnknownSync(AnthropicOptions)(routedOptions(alias, effort)).output_config.effort

const openAiEffort = (alias: string, effort: (typeof efforts)[number]) =>
  Schema.decodeUnknownSync(OpenAiOptions)(routedOptions(alias, effort)).reasoning.effort

const aliasFor = (provider: string) =>
  Object.entries(Settings.Defaults.settingsDefaults.models).find(([, model]) => model.provider === provider)![0]

it.effect("every routable effort builds provider request options the routed protocol accepts", () =>
  Effect.gen(function* () {
    const aliases = Object.entries(Settings.Defaults.settingsDefaults.models)
    expect(aliases.length).toBeGreaterThan(0)
    for (const [alias, model] of aliases) {
      for (const effort of efforts) {
        if (model.variants[effort] === undefined) continue
        const route = ExecutionRouteResolution.resolve(settingsFor(alias, effort), "medium")
        for (const candidate of route.main.candidates) {
          if (candidate.providerConnection.protocol === "openai-responses")
            yield* decoders["openai-responses"](candidate.providerOptions)
          if (candidate.providerConnection.protocol === "anthropic")
            yield* decoders.anthropic(candidate.providerOptions)
        }
      }
    }
  }),
)

it("routed effort reaches the provider as the closest level that protocol supports", () => {
  const anthropic = aliasFor("anthropic")
  const openai = aliasFor("openai")
  expect(efforts.map((effort) => anthropicEffort(anthropic, effort))).toEqual(["low", "medium", "high", "max", "max"])
  expect(efforts.map((effort) => openAiEffort(openai, effort))).toEqual(["low", "medium", "high", "xhigh", "xhigh"])
})

it.effect("Astra max reaches an OpenAI Responses transport request unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const alias = "astra"
      expect(Settings.Defaults.settingsDefaults.models[alias]).toBeDefined()
      const providerOptions = routedOptions(alias, "max")
      const config = yield* OpenAiResponses.decodeConfig(providerOptions)
      let requestBody = ""
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.body._tag === "Uint8Array") requestBody = new TextDecoder().decode(request.body.body)
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  id: "resp_astra_test",
                  object: "response",
                  created_at: 0,
                  status: "completed",
                  error: null,
                  incomplete_details: null,
                  instructions: null,
                  max_output_tokens: 128_000,
                  model: "gpt-6-astra",
                  output: [
                    {
                      id: "msg_astra_test",
                      type: "message",
                      status: "completed",
                      role: "assistant",
                      content: [{ type: "output_text", annotations: [], logprobs: [], text: "ok" }],
                    },
                  ],
                  parallel_tool_calls: true,
                  previous_response_id: null,
                  reasoning: { effort: "max", summary: null },
                  store: true,
                  temperature: 1,
                  text: { format: { type: "text" }, verbosity: "medium" },
                  tool_choice: "auto",
                  tools: [],
                  top_p: 1,
                  truncation: "disabled",
                  usage: {
                    input_tokens: 1,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: 1,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 2,
                  },
                  metadata: {},
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
          )
        }),
      )
      const provider = OpenAiResponses.layer({
        provider: "openai",
        model: "gpt-6-astra",
        config,
        apiKey: Config.succeed(Redacted.make("test-key")),
      }).pipe(Layer.provide(http))
      const context = yield* Layer.build(provider)
      const model = yield* ModelRegistry.withModel(
        { provider: "openai", model: "gpt-6-astra" },
        Effect.service(LanguageModel.LanguageModel),
      ).pipe(Effect.provideService(ModelRegistry.ModelRegistry, Context.get(context, ModelRegistry.ModelRegistry)))
      const chat = yield* Chat.fromPrompt([])
      yield* chat.generateText({ prompt: "hello" }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
      const body = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(requestBody)
      expect(body).toMatchObject({
        model: "gpt-6-astra",
        max_output_tokens: 128_000,
        reasoning: { effort: "max" },
      })
    }),
  ),
)
