import { Config } from "@rika/core"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Modes from "./modes"
import * as Provider from "./provider"
import * as Retry from "./retry"

export interface Options {
  readonly apiKeyEnv?: string
  readonly apiUrl?: string
  readonly model?: Provider.ModelId
}

export const providerName = "openai"
export const defaultApiKeyEnv = "RIKA_API_KEY"

export const requestConfigFromRikaRequest = (
  request: Provider.GenerateRequest,
): typeof OpenAiLanguageModel.Config.Service => {
  const reasoningEffort = openAiReasoningEffort(request.reasoning_effort)
  return {
    model: request.model,
    store: false,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort } }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  }
}

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

export const provider = (options: Options = {}) =>
  Provider.make({
    completeMiddleware: (request) => withRequestConfig(request),
    streamMiddleware: (request) => (stream) => Retry.middleware(request)(withStreamRequestConfig(request)(stream)),
  }).pipe(Effect.provide(languageModelLayer(options)), Effect.provide(clientLayer(options)))

export const layer = (options: Options = {}) =>
  Provider.layer({
    completeMiddleware: (request) => withRequestConfig(request),
    streamMiddleware: (request) => (stream) => Retry.middleware(request)(withStreamRequestConfig(request)(stream)),
  }).pipe(Layer.provide(languageModelLayer(options)), Layer.provide(clientLayer(options)))

const openAiReasoningEffort = (effort: Provider.ReasoningEffort | undefined) => (effort === "max" ? undefined : effort)
