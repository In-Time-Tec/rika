import { Config } from "@rika/core"
import { AnthropicClient, AnthropicLanguageModel, Generated } from "@effect/ai-anthropic"
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as Modes from "./modes"
import * as Provider from "./provider"
import * as Retry from "./retry"

export interface Options {
  readonly apiKeyEnv?: string
  readonly apiUrl?: string
  readonly model?: Provider.ModelId
}

export const providerName = "anthropic"
export const defaultApiKeyEnv = "RIKA_API_KEY"

export const requestConfigFromRikaRequest = (
  request: Provider.GenerateRequest,
): typeof AnthropicLanguageModel.Config.Service => {
  const model = anthropicModel(request.model)
  const reasoningEffort = anthropicReasoningEffort(request.reasoning_effort)
  return {
    ...(model === undefined ? {} : { model }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(reasoningEffort === undefined ? {} : { output_config: { effort: reasoningEffort } }),
  }
}

export const withRequestConfig = (request: Provider.GenerateRequest) => {
  const requestConfig = requestConfigFromRikaRequest(request)

  return <A, E, R>(effect: Effect.Effect<A, E, R>) => AnthropicLanguageModel.withConfigOverride(effect, requestConfig)
}

export const withStreamRequestConfig = (request: Provider.GenerateRequest) => {
  const requestConfig = requestConfigFromRikaRequest(request)

  return <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    Stream.provideService(stream, AnthropicLanguageModel.Config, requestConfig)
}

export const clientLayer = (options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* Config.Service
      const apiKey = yield* config.requireEnv(options.apiKeyEnv ?? defaultApiKeyEnv)

      return AnthropicClient.layer({
        apiKey: Redacted.make(apiKey),
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        transformClient: transformClient,
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )

export const languageModelLayer = (options: Options = {}) =>
  AnthropicLanguageModel.model(options.model ?? Modes.smartModel)

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

const anthropicModel = (model: Provider.ModelId): Generated.Model | undefined => {
  const decoded = Schema.decodeUnknownOption(Generated.Model)(model)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const anthropicReasoningEffort = (
  effort: Provider.ReasoningEffort | undefined,
): "low" | "medium" | "high" | undefined => {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort
    case "max":
      return "high"
    default:
      return undefined
  }
}

export const stripMaxTokensFromClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.mapRequest(client, stripMaxTokensFromRequest)

export const transformClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  stripMaxTokensFromClient(client).pipe(HttpClient.transformResponse(Effect.map(normalizeResponseModel)))

export const stripMaxTokensFromRequest = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  if (request.body._tag !== "Uint8Array" || request.body.contentType !== "application/json") return request
  const body = JSON.parse(new TextDecoder().decode(request.body.body))
  if (!isRecord(body) || !Object.hasOwn(body, "max_tokens")) return request
  delete body.max_tokens
  return HttpClientRequest.bodyJsonUnsafe(request, body)
}

export const normalizeResponseModel = (
  response: HttpClientResponse.HttpClientResponse,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    response.request,
    new Response(Stream.toReadableStream(normalizedResponseBody(response.stream)), {
      status: response.status,
      headers: response.headers,
    }),
  )

const normalizedResponseBody = (body: Stream.Stream<Uint8Array, unknown>): Stream.Stream<Uint8Array, unknown> =>
  Stream.suspend(() => {
    let carry = ""
    return body.pipe(
      Stream.decodeText,
      Stream.map((chunk) => {
        const text = replaceResponseModelAliases(carry + chunk)
        const emitLength = Math.max(0, text.length - responseModelCarryLength)
        const emit = text.slice(0, emitLength)
        carry = text.slice(emitLength)
        return encodeText(emit)
      }),
      Stream.concat(Stream.sync(() => encodeText(replaceResponseModelAliases(carry)))),
    )
  })

const responseModelAliases = [{ from: '"model":"claude-opus-4-8"', to: '"model":"claude-opus-4-6"' }]
const responseModelCarryLength = Math.max(...responseModelAliases.map((alias) => alias.from.length - 1))
const textEncoder = new TextEncoder()

const replaceResponseModelAliases = (text: string): string => {
  let next = text
  for (const alias of responseModelAliases) {
    next = next.replaceAll(alias.from, alias.to)
  }
  return next
}

const encodeText = (text: string): Uint8Array => textEncoder.encode(text)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
