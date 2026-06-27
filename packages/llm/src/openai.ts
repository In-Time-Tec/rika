import { Config } from "@rika/core"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Modes from "./modes"
import * as Provider from "./provider"

export interface Options {
  readonly apiKeyEnv?: string
  readonly apiUrl?: string
  readonly model?: Provider.ModelId
}

export const providerName = "openai"
export const defaultApiKeyEnv = "OPENAI_API_KEY"

export const requestConfigFromRikaRequest = (
  request: Provider.GenerateRequest,
): typeof OpenAiLanguageModel.Config.Service => ({
  model: request.model,
  store: false,
  ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  ...(request.max_output_tokens === undefined ? {} : { max_output_tokens: request.max_output_tokens }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  ...(request.reasoning_effort === undefined ? {} : { reasoning: { effort: request.reasoning_effort } }),
})

export const withRequestConfig = (request: Provider.GenerateRequest) => {
  const requestConfig = requestConfigFromRikaRequest(request)

  return <A, E, R>(effect: Effect.Effect<A, E, R>) => OpenAiLanguageModel.withConfigOverride(effect, requestConfig)
}

export const withStreamRequestConfig = (request: Provider.GenerateRequest) => {
  const requestConfig = requestConfigFromRikaRequest(request)

  return <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    Stream.provideService(stream, OpenAiLanguageModel.Config, requestConfig)
}

export const clientLayer = (options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* Config.Service
      const apiKey = yield* config.requireEnv(options.apiKeyEnv ?? defaultApiKeyEnv)

      return OpenAiClient.layer({
        apiKey: Redacted.make(apiKey),
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )

export const languageModelLayer = (options: Options = {}) =>
  OpenAiLanguageModel.model(options.model ?? Modes.defaultModel, { store: false })

export const layer = (options: Options = {}) =>
  Provider.layer({
    completeMiddleware: (request) => withRequestConfig(request),
    streamMiddleware: (request) => withStreamRequestConfig(request),
  }).pipe(Layer.provide(languageModelLayer(options)), Layer.provide(clientLayer(options)))
