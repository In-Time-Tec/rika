import { Config } from "@rika/core"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as Modes from "./modes"
import * as Provider from "./provider"
import * as Retry from "./retry"

export interface Options {
  readonly apiKeyEnv?: string
  readonly apiUrl?: string
  readonly model?: Provider.ModelId
}

export interface StripMaxTokensOptions {
  readonly enabled?: boolean
}

export interface ClientTransformOptions {
  readonly stripMaxTokens?: boolean
}

export const providerName = "anthropic"
export const defaultApiKeyEnv = "RIKA_API_KEY"

export const requestConfigFromRikaRequest = (
  request: Provider.GenerateRequest,
): typeof AnthropicLanguageModel.Config.Service => {
  const reasoningEffort = anthropicReasoningEffort(request.reasoning_effort)
  const requestConfig: typeof AnthropicLanguageModel.Config.Service = {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(reasoningEffort === undefined ? {} : { output_config: { effort: reasoningEffort } }),
  }
  return Object.assign(requestConfig, { model: request.model })
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
      const apiKey = yield* config.requireSecret(options.apiKeyEnv ?? defaultApiKeyEnv)

      return AnthropicClient.layer({
        apiKey,
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        transformClient: (client) => transformClient(client, { stripMaxTokens: options.apiUrl !== undefined }),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  )

export const languageModelLayer = (options: Options = {}) =>
  AnthropicLanguageModel.model(options.model ?? Modes.smartModel)

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
  HttpClient.mapRequest(client, (request) => stripMaxTokensFromRequest(request))

export const transformClient = (
  client: HttpClient.HttpClient,
  options: ClientTransformOptions = {},
): HttpClient.HttpClient =>
  (options.stripMaxTokens === true ? stripMaxTokensFromClient(client) : client).pipe(
    HttpClient.transformResponse(Effect.map(normalizeResponseModel)),
  )

export const stripMaxTokensFromRequest = (
  request: HttpClientRequest.HttpClientRequest,
  options: StripMaxTokensOptions = {},
): HttpClientRequest.HttpClientRequest => {
  if (options.enabled === false) return request
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
    new Response(Stream.toReadableStream(normalizedResponseBody(response.stream, isEventStream(response.headers))), {
      status: response.status,
      headers: response.headers,
    }),
  )

const normalizedResponseBody = (
  body: Stream.Stream<Uint8Array, unknown>,
  eventStream: boolean,
): Stream.Stream<Uint8Array, unknown> =>
  eventStream ? normalizedSseResponseBody(body) : normalizedJsonResponseBody(body)

const normalizedJsonResponseBody = (body: Stream.Stream<Uint8Array, unknown>): Stream.Stream<Uint8Array, unknown> =>
  Stream.unwrap(
    body.pipe(
      Stream.decodeText,
      Stream.runFold(
        () => "",
        (text, chunk) => text + chunk,
      ),
      Effect.map((text) => Stream.succeed(encodeText(replaceJsonModelAliases(text)))),
    ),
  )

const normalizedSseResponseBody = (body: Stream.Stream<Uint8Array, unknown>): Stream.Stream<Uint8Array, unknown> =>
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
        return encodeText(replaceResponseModelAliases(complete))
      }),
      Stream.concat(Stream.sync(() => encodeText(replaceResponseModelAliases(carry)))),
    )
  })

const responseModelAliases = new Map([["claude-opus-4-8", "claude-opus-4-6"]])
const textEncoder = new TextEncoder()

const replaceResponseModelAliases = (text: string): string => {
  const sse = replaceSseDataModelAliases(text)
  if (sse !== text) return sse
  return replaceJsonModelAliases(text)
}

const replaceSseDataModelAliases = (text: string): string => {
  let output = ""
  let index = 0
  let changed = false
  while (index < text.length) {
    const lineEnd = text.indexOf("\n", index)
    const end = lineEnd === -1 ? text.length : lineEnd + 1
    const line = text.slice(index, end)
    const next = replaceSseDataLineModelAliases(line)
    if (next !== line) changed = true
    output += next
    index = end
  }
  return changed ? output : text
}

const replaceSseDataLineModelAliases = (line: string): string => {
  const eol = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""
  const body = eol.length === 0 ? line : line.slice(0, -eol.length)
  const match = /^(data:[ \t]?)(.*)$/s.exec(body)
  if (match === null) return line
  const prefix = match[1]
  const data = match[2]
  if (prefix === undefined || data === undefined) return line
  const parsed = parseJson(data)
  if (parsed === undefined) return line
  const normalized = normalizeSseEnvelopeModel(parsed.value)
  return normalized.changed ? `${prefix}${JSON.stringify(normalized.value)}${eol}` : line
}

const replaceJsonModelAliases = (text: string): string => {
  const parsed = parseJson(text)
  if (parsed === undefined) return text
  const normalized = normalizeJsonResponseModel(parsed.value)
  return normalized.changed ? JSON.stringify(normalized.value) : text
}

const parseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

const normalizeSseEnvelopeModel = (value: unknown): { readonly value: unknown; readonly changed: boolean } => {
  if (!isRecord(value)) return { value, changed: false }
  if (value.type !== "message_start" && value.type !== "message_delta") return { value, changed: false }
  let next = value
  let changed = false
  if (isRecord(value.message)) {
    const normalized = normalizeModelField(value.message)
    if (normalized.changed) {
      next = { ...next, message: normalized.value }
      changed = true
    }
  }
  if (isRecord(value.delta)) {
    const normalized = normalizeModelField(value.delta)
    if (normalized.changed) {
      next = { ...next, delta: normalized.value }
      changed = true
    }
  }
  return { value: next, changed }
}

const normalizeJsonResponseModel = (value: unknown): { readonly value: unknown; readonly changed: boolean } => {
  if (!isRecord(value)) return { value, changed: false }
  return normalizeModelField(value)
}

const normalizeModelField = (
  value: Record<string, unknown>,
): { readonly value: Record<string, unknown>; readonly changed: boolean } => {
  const alias = typeof value.model === "string" ? responseModelAliases.get(value.model) : undefined
  return alias === undefined ? { value, changed: false } : { value: { ...value, model: alias }, changed: true }
}

const encodeText = (text: string): Uint8Array => textEncoder.encode(text)

const isEventStream = (headers: Readonly<Record<string, string | undefined>>) =>
  headers["content-type"]?.toLowerCase().includes("text/event-stream") === true

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
