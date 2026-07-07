import { Config } from "@rika/core"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
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
  const store: boolean = false
  return {
    model: request.model,
    store,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort } }),
    ...(store && request.metadata !== undefined ? { metadata: request.metadata } : {}),
    ...(request.service_tier === undefined ? {} : { service_tier: request.service_tier }),
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
      const apiKey = yield* config.requireSecret(options.apiKeyEnv ?? defaultApiKeyEnv)

      return OpenAiClient.layer({
        apiKey,
        ...(options.apiUrl === undefined
          ? {}
          : { apiUrl: options.apiUrl, transformClient: dropDoneSentinelFromClient }),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )

export const dropDoneSentinelFromClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(HttpClient.transformResponse(Effect.map(dropDoneSentinelFromResponse)))

const dropDoneSentinelFromResponse = (
  response: HttpClientResponse.HttpClientResponse,
): HttpClientResponse.HttpClientResponse =>
  isEventStream(response.headers)
    ? HttpClientResponse.fromWeb(
        response.request,
        new Response(Stream.toReadableStream(sseBodyWithoutDone(response.stream)), {
          status: response.status,
          headers: response.headers,
        }),
      )
    : response

const sseBodyWithoutDone = (body: Stream.Stream<Uint8Array, unknown>): Stream.Stream<Uint8Array, unknown> =>
  Stream.suspend(() => {
    let carry = ""
    return body.pipe(
      Stream.decodeText,
      Stream.map((chunk) => {
        const text = carry + chunk
        const lineEnd = text.lastIndexOf("\n")
        if (lineEnd === -1) {
          carry = text
          return encodeText("")
        }
        const complete = text.slice(0, lineEnd + 1)
        carry = text.slice(lineEnd + 1)
        return encodeText(withoutDoneLines(complete))
      }),
      Stream.concat(Stream.sync(() => encodeText(withoutDoneLines(carry)))),
    )
  })

export const withoutDoneLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !isDoneLine(line))
    .join("\n")

const isDoneLine = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]"
}

const isEventStream = (headers: Readonly<Record<string, string | undefined>>): boolean =>
  headers["content-type"]?.toLowerCase().includes("text/event-stream") === true

const textEncoder = new TextEncoder()
const encodeText = (text: string): Uint8Array => textEncoder.encode(text)

export const languageModelLayer = (options: Options = {}) =>
  OpenAiLanguageModel.model(options.model ?? Modes.defaultModel, { store: false })

export const provider = (options: Options = {}) =>
  Provider.make({
    completeMiddleware: (request) => (effect) => Retry.completeMiddleware(request)(withRequestConfig(request)(effect)),
    completeStructuredMiddleware: (request) => (effect) =>
      Retry.completeStructuredMiddleware(request)(withRequestConfig(request)(effect)),
    streamMiddleware: (request) => (stream) => Retry.middleware(request)(withStreamRequestConfig(request)(stream)),
  }).pipe(Effect.provide(languageModelLayer(options)), Effect.provide(clientLayer(options)))

export const layer = (options: Options = {}) =>
  Provider.layer({
    completeMiddleware: (request) => (effect) => Retry.completeMiddleware(request)(withRequestConfig(request)(effect)),
    completeStructuredMiddleware: (request) => (effect) =>
      Retry.completeStructuredMiddleware(request)(withRequestConfig(request)(effect)),
    streamMiddleware: (request) => (stream) => Retry.middleware(request)(withStreamRequestConfig(request)(stream)),
  }).pipe(Layer.provide(languageModelLayer(options)), Layer.provide(clientLayer(options)))

const openAiReasoningEffort = (effort: Provider.ReasoningEffort | undefined) => (effort === "max" ? undefined : effort)
