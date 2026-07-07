import { Config, Diagnostics } from "@rika/core"
import { Cause, Clock, Context, Effect, Exit, JsonSchema, Layer, Schema, Stream } from "effect"
import { AiError, Prompt } from "effect/unstable/ai"
import * as ExtractJson from "./extract-json"
import * as Modes from "./modes"
import * as Provider from "./provider"

export interface Request extends Schema.Schema.Type<typeof Request>, Provider.RuntimeOptions {}
export const Request = Schema.Struct({
  mode: Schema.optional(Modes.ModeName),
  profile: Schema.optional(Modes.ProfileName),
  provider: Schema.optional(Provider.ProviderName),
  model: Schema.optional(Provider.ModelId),
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Schema.optional(Provider.ReasoningEffort),
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
  fast_mode: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.LLM.Router.Request" })

export interface RoutedRequest extends Schema.Schema.Type<typeof RoutedRequest>, Provider.RuntimeOptions {}
export const RoutedRequest = Schema.Struct({
  mode: Modes.ModeName,
  profile: Schema.optional(Modes.ProfileName),
  provider: Provider.ProviderName,
  model: Provider.ModelId,
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Provider.ReasoningEffort,
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
  service_tier: Schema.optional(Provider.ServiceTier),
}).annotate({ identifier: "Rika.LLM.Router.RoutedRequest" })

export class RouterError extends Schema.TaggedErrorClass<RouterError>()("RouterError", {
  message: Schema.String,
  mode: Schema.optional(Modes.ModeName),
  profile: Schema.optional(Modes.ProfileName),
  provider: Schema.optional(Provider.ProviderName),
}) {}

export class StructuredOutputError extends Schema.TaggedErrorClass<StructuredOutputError>()("StructuredOutputError", {
  raw_content: Schema.String,
  decode_error: Schema.String,
}) {}

export interface StructuredRequest<A extends Record<string, any>> extends Request {
  readonly schema: Schema.Codec<A, Record<string, any>>
  readonly retries?: number
  readonly objectName?: string
}

export interface StructuredResponse<A extends Record<string, any>> {
  readonly value: A
  readonly raw: Provider.GenerateResponse
}

export interface Interface {
  readonly route: (request: Request) => Effect.Effect<RoutedRequest, RouterError>
  readonly complete: (
    request: Request,
  ) => Effect.Effect<Provider.GenerateResponse, Provider.ProviderError | RouterError>
  readonly completeStructured: <A extends Record<string, any>>(
    request: StructuredRequest<A>,
  ) => Effect.Effect<StructuredResponse<A>, Provider.ProviderError | RouterError | StructuredOutputError>
  readonly stream: (request: Request) => Stream.Stream<Provider.StreamEvent, Provider.ProviderError | RouterError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/llm/Router") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const registry = yield* Provider.Registry
    const diagnostics = yield* Diagnostics.Service
    const route = makeRoute(config)
    const completeRequest = Effect.fn("LLM.Router.complete")(function* (request: Request) {
      const routed = yield* route(request)
      const provider = yield* providerFor(registry, routed)
      const startedAt = yield* Clock.currentTimeMillis
      const fields = llmCallSeed(routed, "message")
      return yield* provider.complete(routed).pipe(
        Effect.tap((response) => Effect.sync(() => enrichResponseFields(fields, response))),
        Effect.onExit((exit) => emitLlmCall(diagnostics, startedAt, fields, exit)),
      )
    })
    const completeStructuredNative = Effect.fn("LLM.Router.completeStructured.native")(function* <
      A extends Record<string, any>,
    >(request: StructuredRequest<A>) {
      const routed = yield* route(request)
      const provider = yield* providerFor(registry, routed)
      const startedAt = yield* Clock.currentTimeMillis
      const fields = llmCallSeed(routed, "message")
      const structuredRequest: Provider.StructuredRequest<A> = {
        ...routed,
        schema: request.schema,
        ...(request.objectName === undefined ? {} : { objectName: request.objectName }),
      }
      return yield* provider.completeStructured(structuredRequest).pipe(
        Effect.tap((response) => Effect.sync(() => enrichResponseFields(fields, response.raw))),
        Effect.onExit((exit) => emitLlmCall(diagnostics, startedAt, fields, exit)),
      )
    })

    return Service.of({
      route,
      complete: completeRequest,
      completeStructured: Effect.fn("LLM.Router.completeStructured")(function* <A extends Record<string, any>>(
        request: StructuredRequest<A>,
      ) {
        return yield* completeStructuredNative(request).pipe(
          Effect.catch((error) => {
            if (!shouldUsePromptStructuredFallback(error)) return Effect.fail(error)
            return completeStructuredPromptRequest(completeRequest, request)
          }),
        )
      }),
      stream: (request: Request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const routed = yield* route(request)
            const provider = yield* providerFor(registry, routed)
            return instrumentStream(diagnostics, routed, provider.stream(routed))
          }),
        ),
    })
  }),
)

export const route = Effect.fn("LLM.Router.route.call")(function* (request: Request) {
  const router = yield* Service
  return yield* router.route(request)
})

export const complete = Effect.fn("LLM.Router.complete.call")(function* (request: Request) {
  const router = yield* Service
  return yield* router.complete(request)
})

export const completeStructured = Effect.fn("LLM.Router.completeStructured.call")(function* <
  A extends Record<string, any>,
>(request: StructuredRequest<A>) {
  const router = yield* Service
  return yield* router.completeStructured(request)
})

export const stream = (request: Request) => Stream.unwrap(Effect.map(Service, (router) => router.stream(request)))

const completeStructuredPromptRequest = <A extends Record<string, any>>(
  completeRequest: (request: Request) => Effect.Effect<Provider.GenerateResponse, Provider.ProviderError | RouterError>,
  request: StructuredRequest<A>,
) => completeStructuredAttempt(completeRequest, request, structuredInitialMessages(request), request.retries ?? 1)

const completeStructuredAttempt = <A extends Record<string, any>>(
  completeRequest: (request: Request) => Effect.Effect<Provider.GenerateResponse, Provider.ProviderError | RouterError>,
  request: StructuredRequest<A>,
  messages: ReadonlyArray<Provider.Message>,
  retriesRemaining: number,
): Effect.Effect<StructuredResponse<A>, Provider.ProviderError | RouterError | StructuredOutputError> =>
  Effect.gen(function* () {
    const raw = yield* completeRequest(structuredRequestWithMessages(request, messages))
    return yield* decodeStructuredContent(request.schema, raw.content).pipe(
      Effect.map((value) => ({ value, raw })),
      Effect.catchTag("StructuredOutputError", (error) => {
        if (retriesRemaining <= 0) return Effect.fail(error)
        return completeStructuredAttempt(
          completeRequest,
          request,
          correctiveStructuredMessages(messages, raw.content, error),
          retriesRemaining - 1,
        )
      }),
    )
  })

const structuredInitialMessages = <A extends Record<string, any>>(
  request: StructuredRequest<A>,
): ReadonlyArray<Provider.Message> =>
  request.prompt === undefined
    ? [...request.messages, structuredOutputInstruction(request.schema)]
    : [structuredOutputInstruction(request.schema)]

const structuredOutputInstruction = <A extends Record<string, any>>(
  schema: Schema.Codec<A, Record<string, any>>,
): Provider.Message => ({
  role: "system",
  content: `Return only JSON matching this JSON Schema.\n${JSON.stringify(jsonSchemaFor(schema))}`,
})

const correctiveStructuredMessages = (
  messages: ReadonlyArray<Provider.Message>,
  rawContent: string,
  error: StructuredOutputError,
): ReadonlyArray<Provider.Message> => [
  ...messages,
  { role: "assistant", content: rawContent },
  {
    role: "user",
    content: `The previous response did not match the required schema: ${error.decode_error}\nReturn only corrected JSON.`,
  },
]

const jsonSchemaFor = <A extends Record<string, any>>(
  schema: Schema.Codec<A, Record<string, any>>,
): JsonSchema.JsonSchema => {
  const document = JsonSchema.resolveTopLevel$ref(Schema.toJsonSchemaDocument(schema))
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const structuredRequestWithMessages = <A extends Record<string, any>>(
  request: StructuredRequest<A>,
  messages: ReadonlyArray<Provider.Message>,
): Request => ({
  ...(request.mode === undefined ? {} : { mode: request.mode }),
  ...(request.profile === undefined ? {} : { profile: request.profile }),
  ...(request.provider === undefined ? {} : { provider: request.provider }),
  ...(request.model === undefined ? {} : { model: request.model }),
  messages: request.prompt === undefined ? messages : request.messages,
  ...(request.reasoning_effort === undefined ? {} : { reasoning_effort: request.reasoning_effort }),
  ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  ...(request.fast_mode === undefined ? {} : { fast_mode: request.fast_mode }),
  ...(request.prompt === undefined ? {} : { prompt: structuredPrompt(request.prompt, messages) }),
  ...(request.toolkit === undefined ? {} : { toolkit: request.toolkit }),
})

const structuredPrompt = (prompt: Prompt.RawInput, messages: ReadonlyArray<Provider.Message>): Prompt.Prompt =>
  Prompt.concat(Prompt.make(prompt), Provider.promptFromMessages(messages))

const decodeStructuredContent = <A extends Record<string, any>>(
  schema: Schema.Codec<A, Record<string, any>>,
  content: string,
) =>
  Effect.gen(function* () {
    const json = ExtractJson.extractJson(content)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: (error) =>
        new StructuredOutputError({
          raw_content: content,
          decode_error: errorMessage(error),
        }),
    })
    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
      Effect.mapError(
        (error) =>
          new StructuredOutputError({
            raw_content: content,
            decode_error: String(error),
          }),
      ),
    )
  })

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const shouldUsePromptStructuredFallback = (error: unknown) =>
  AiError.isAiError(error) &&
  (error.reason._tag === "InvalidOutputError" ||
    error.reason._tag === "StructuredOutputError" ||
    error.reason._tag === "UnsupportedSchemaError")

const makeRoute = (config: Config.Interface) =>
  Effect.fn("LLM.Router.route")(function* (request: Request) {
    const values = yield* config.get
    const modeName = request.mode ?? values.default_mode
    const routing = request.profile === undefined ? Modes.get(modeName) : Modes.getProfile(request.profile)
    const provider = request.provider ?? routing.provider
    const model = request.model ?? Modes.primaryModel(routing)
    const temperature = request.temperature ?? routing.temperature
    const metadata = request.metadata
    const serviceTier: Provider.ServiceTier | undefined =
      request.fast_mode === true && provider === "openai" ? "priority" : undefined

    return {
      mode: modeName,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      provider,
      model,
      messages: request.messages,
      reasoning_effort: request.reasoning_effort ?? routing.reasoning_effort,
      ...(temperature === undefined ? {} : { temperature }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.toolkit === undefined ? {} : { toolkit: request.toolkit }),
    }
  })

const llmCallSeed = (routed: RoutedRequest, kind: "message" | "stream"): Diagnostics.Fields => ({
  provider: routed.provider,
  model: routed.model,
  mode: routed.mode,
  ...(routed.profile === undefined ? {} : { profile: routed.profile }),
  reasoning_effort: routed.reasoning_effort,
  ...(routed.service_tier === undefined ? {} : { service_tier: routed.service_tier }),
  request_kind: routed.toolkit === undefined ? kind : "tool",
  message_count: routed.messages.length,
})

const enrichResponseFields = (fields: Diagnostics.Fields, response: Provider.GenerateResponse): void => {
  if (response.id !== undefined) fields.response_id = response.id
  if (response.finish_reason !== undefined) fields.finish_reason = response.finish_reason
  const usage = response.usage
  if (usage === undefined) return
  if (usage.input_tokens !== undefined) fields.token_in = usage.input_tokens
  if (usage.output_tokens !== undefined) fields.token_out = usage.output_tokens
  if (usage.reasoning_tokens !== undefined) fields.reasoning_tokens = usage.reasoning_tokens
  if (usage.total_tokens !== undefined) fields.total_tokens = usage.total_tokens
}

const instrumentStream = (
  diagnostics: Diagnostics.Interface,
  routed: RoutedRequest,
  source: Stream.Stream<Provider.StreamEvent, Provider.ProviderError>,
): Stream.Stream<Provider.StreamEvent, Provider.ProviderError> =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (startedAt) => {
      const fields = llmCallSeed(routed, "stream")
      let toolCalls = 0
      let eventCount = 0
      let completed = false
      return source.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            eventCount += 1
            if (event.type === "tool.call") toolCalls += 1
            if (event.type === "response.completed") {
              completed = true
              fields.tool_call_count = toolCalls
              enrichResponseFields(fields, event.response)
            }
          }),
        ),
        Stream.onExit((exit) => emitLlmCall(diagnostics, startedAt, fields, exit, { eventCount, completed })),
      )
    }),
  )

const emitLlmCall = <A>(
  diagnostics: Diagnostics.Interface,
  startedAt: number,
  fields: Diagnostics.Fields,
  exit: Exit.Exit<A, Provider.ProviderError>,
  streamStats?: { readonly eventCount: number; readonly completed: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const endedAt = yield* Clock.currentTimeMillis
    const empty =
      Exit.isSuccess(exit) && streamStats !== undefined && (streamStats.eventCount === 0 || !streamStats.completed)
    const outcome = Exit.isFailure(exit) ? "error" : empty ? "empty" : "success"
    yield* diagnostics.emit({
      level: outcome === "success" ? "info" : outcome === "empty" ? "warn" : "error",
      message: `llm.call ${outcome}`,
      data: {
        ...fields,
        op: "llm.call",
        outcome,
        duration_ms: endedAt - startedAt,
        ...(streamStats === undefined
          ? {}
          : { stream_events: streamStats.eventCount, stream_completed: streamStats.completed }),
        ...(Exit.isSuccess(exit) ? {} : { error: Cause.pretty(exit.cause) }),
      },
    })
  })

const providerFor = (registry: Provider.RegistryInterface, request: RoutedRequest) => {
  const provider = registry.get(request.provider)
  if (provider !== undefined) return Effect.succeed(provider)
  return new RouterError({
    message: `Mode ${request.mode} routed to provider ${request.provider}, but no provider layer is registered`,
    mode: request.mode,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    provider: request.provider,
  })
}
