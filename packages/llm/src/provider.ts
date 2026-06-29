import { Context, Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Model, Prompt, Response } from "effect/unstable/ai"

export const ProviderName = Schema.String.annotate({ identifier: "Rika.LLM.ProviderName" })
export type ProviderName = typeof ProviderName.Type

export const ModelId = Schema.String.annotate({ identifier: "Rika.LLM.ModelId" })
export type ModelId = typeof ModelId.Type

export const Role = Schema.Literals(["system", "developer", "user", "assistant", "tool"]).annotate({
  identifier: "Rika.LLM.MessageRole",
})
export type Role = typeof Role.Type

export const ReasoningEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"]).annotate({
  identifier: "Rika.LLM.ReasoningEffort",
})
export type ReasoningEffort = typeof ReasoningEffort.Type

export interface Message extends Schema.Schema.Type<typeof Message> {}
export const Message = Schema.Struct({
  role: Role,
  content: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.LLM.Message" })

export const Metadata = Schema.Record(Schema.String, Schema.String).annotate({
  identifier: "Rika.LLM.Metadata",
})
export type Metadata = typeof Metadata.Type

export interface GenerateRequest extends Schema.Schema.Type<typeof GenerateRequest>, RuntimeOptions {}
export const GenerateRequest = Schema.Struct({
  provider: ProviderName,
  model: ModelId,
  messages: Schema.Array(Message),
  reasoning_effort: Schema.optional(ReasoningEffort),
  max_output_tokens: Schema.optional(Schema.Int),
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.LLM.GenerateRequest" })

export type ToolkitInput = LanguageModel.ToolkitInput<any, never, never>

export interface RuntimeOptions {
  readonly prompt?: Prompt.RawInput
  readonly toolkit?: ToolkitInput
}

export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Int),
  output_tokens: Schema.optional(Schema.Int),
  reasoning_tokens: Schema.optional(Schema.Int),
  total_tokens: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.LLM.Usage" })

export const FinishReason = Schema.Literals([
  "stop",
  "length",
  "tool-call",
  "content-filter",
  "error",
  "unknown",
]).annotate({
  identifier: "Rika.LLM.FinishReason",
})
export type FinishReason = typeof FinishReason.Type

export interface GenerateResponse extends Schema.Schema.Type<typeof GenerateResponse> {}
export const GenerateResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  provider: ProviderName,
  model: ModelId,
  content: Schema.String,
  finish_reason: Schema.optional(FinishReason),
  usage: Schema.optional(Usage),
}).annotate({ identifier: "Rika.LLM.GenerateResponse" })

export interface ResponseStarted extends Schema.Schema.Type<typeof ResponseStarted> {}
export const ResponseStarted = Schema.Struct({
  type: Schema.Literal("response.started"),
  provider: ProviderName,
  model: ModelId,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ResponseStarted" })

export interface ContentDelta extends Schema.Schema.Type<typeof ContentDelta> {}
export const ContentDelta = Schema.Struct({
  type: Schema.Literal("content.delta"),
  text: Schema.String,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ContentDelta" })

export interface ReasoningDelta extends Schema.Schema.Type<typeof ReasoningDelta> {}
export const ReasoningDelta = Schema.Struct({
  type: Schema.Literal("reasoning.delta"),
  text: Schema.String,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ReasoningDelta" })

export interface ToolInputStarted extends Schema.Schema.Type<typeof ToolInputStarted> {}
export const ToolInputStarted = Schema.Struct({
  type: Schema.Literal("tool.input.started"),
  id: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ToolInputStarted" })

export interface ToolInputDelta extends Schema.Schema.Type<typeof ToolInputDelta> {}
export const ToolInputDelta = Schema.Struct({
  type: Schema.Literal("tool.input.delta"),
  id: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ToolInputDelta" })

export interface ToolInputEnded extends Schema.Schema.Type<typeof ToolInputEnded> {}
export const ToolInputEnded = Schema.Struct({
  type: Schema.Literal("tool.input.ended"),
  id: Schema.String,
  name: Schema.String,
  input_text: Schema.String,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ToolInputEnded" })

export interface ToolCall extends Schema.Schema.Type<typeof ToolCall> {}
export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool.call"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ToolCall" })

export interface ToolResult extends Schema.Schema.Type<typeof ToolResult> {}
export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool.result"),
  id: Schema.String,
  name: Schema.String,
  result: Schema.Unknown,
  is_failure: Schema.Boolean,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ToolResult" })

export interface ResponseCompleted extends Schema.Schema.Type<typeof ResponseCompleted> {}
export const ResponseCompleted = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: GenerateResponse,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ResponseCompleted" })

export type StreamEvent =
  | ResponseStarted
  | ContentDelta
  | ReasoningDelta
  | ToolInputStarted
  | ToolInputDelta
  | ToolInputEnded
  | ToolCall
  | ToolResult
  | ResponseCompleted
export const StreamEvent = Schema.Union([
  ResponseStarted,
  ContentDelta,
  ReasoningDelta,
  ToolInputStarted,
  ToolInputDelta,
  ToolInputEnded,
  ToolCall,
  ToolResult,
  ResponseCompleted,
]).pipe(Schema.toTaggedUnion("type"), Schema.annotate({ identifier: "Rika.LLM.StreamEvent" }))

export type ProviderError = AiError.AiError

export type CompleteMiddleware = (
  request: GenerateRequest,
) => (effect: Effect.Effect<GenerateResponse, ProviderError>) => Effect.Effect<GenerateResponse, ProviderError>

export type StreamMiddleware = (
  request: GenerateRequest,
) => (stream: Stream.Stream<StreamEvent, ProviderError>) => Stream.Stream<StreamEvent, ProviderError>

export interface LayerOptions {
  readonly completeMiddleware?: CompleteMiddleware
  readonly streamMiddleware?: StreamMiddleware
}

export interface Interface {
  readonly name: ProviderName
  readonly complete: (request: GenerateRequest) => Effect.Effect<GenerateResponse, ProviderError>
  readonly stream: (request: GenerateRequest) => Stream.Stream<StreamEvent, ProviderError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/llm/Provider") {}

export interface FakeToolCallResponse {
  readonly type: "tool-call"
  readonly name: string
  readonly input: unknown
  readonly id?: string
  readonly input_text?: string
  readonly content?: string
  readonly result?: unknown
  readonly is_failure?: boolean
}

export type FakeResponse = string | GenerateResponse | FakeToolCallResponse

export interface FakeOptions {
  readonly name?: ProviderName
  readonly failStreamWith?: AiError.AiError
}

export const layer = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const languageModel = yield* LanguageModel.LanguageModel
      const providerName = yield* Model.ProviderName

      return Service.of({
        name: providerName,
        complete: Effect.fn("LLM.Provider.complete")(function* (request: GenerateRequest) {
          const complete = completeWithLanguageModel(languageModel, request)
          const withMiddleware = options.completeMiddleware?.(request)(complete) ?? complete
          return yield* withMiddleware
        }),
        stream: (request: GenerateRequest) => {
          const stream = streamWithLanguageModel(languageModel, request)
          return options.streamMiddleware?.(request)(stream) ?? stream
        },
      })
    }),
  )

export const fakeLayer = (responses: ReadonlyArray<FakeResponse> = ["fake response"], options: FakeOptions = {}) => {
  const providerName = options.name ?? "openai"
  return layer().pipe(Layer.provide(fakeLanguageModelLayer(responses, { ...options, name: providerName })))
}

export const fakeLanguageModelLayer = (
  responses: ReadonlyArray<FakeResponse> = ["fake response"],
  options: FakeOptions = {},
) => {
  let nextIndex = 0
  const providerName = options.name ?? "openai"

  const languageModelLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: Effect.fn("LLM.Provider.fake.generateText")(function* () {
        const response = responseAt(responses, nextIndex)
        nextIndex += 1
        return [...aiPartsFromFakeResponse(response)]
      }),
      streamText: () => {
        const response = responseAt(responses, nextIndex)
        nextIndex += 1
        const normalized = normalizeFakeResponse(response)
        if (options.failStreamWith !== undefined) {
          return Stream.fromIterable<Response.StreamPartEncoded>([
            { type: "text-start", id: "fake-text" },
            { type: "text-delta", id: "fake-text", delta: normalized.content },
          ]).pipe(Stream.concat(Stream.fail(options.failStreamWith)))
        }
        return Stream.fromIterable(aiStreamPartsFromFakeResponse(response))
      },
    }),
  )

  return Layer.mergeAll(Layer.succeed(Model.ProviderName, providerName), languageModelLayer)
}

export const completeWithLanguageModel = (languageModel: LanguageModel.Service, request: GenerateRequest) =>
  languageModel.generateText({ prompt: request.prompt ?? promptFromMessages(request.messages) }).pipe(
    Effect.map((response) => responseFromGenerateText(request, response)),
    Effect.catch((error: ProviderError) =>
      AiError.isAiError(error) && error.reason._tag === "InvalidOutputError"
        ? Effect.succeed<GenerateResponse>({
            provider: request.provider,
            model: request.model,
            content: "",
            finish_reason: "stop",
          })
        : Effect.fail(error),
    ),
  )

export const streamWithLanguageModel = (
  languageModel: LanguageModel.Service,
  request: GenerateRequest,
): Stream.Stream<StreamEvent, ProviderError> =>
  Stream.suspend(() => {
    const state: StreamState = { content: "", toolInputs: new Map() }
    const start: ResponseStarted = { type: "response.started", provider: request.provider, model: request.model }
    const prompt = request.prompt ?? promptFromMessages(request.messages)
    const stream =
      request.toolkit === undefined
        ? languageModel.streamText({ prompt })
        : languageModel.streamText({
            prompt,
            toolkit: request.toolkit,
            toolChoice: "auto",
          })
    const body = stream.pipe(
      Stream.provideContext(emptyContext()),
      Stream.flatMap((part) => Stream.fromIterable(streamEventsFromAiPart(part, state))),
      Stream.catchReason("AiError", "InvalidOutputError", () => {
        state.finish_reason ??= "stop"
        return Stream.empty
      }),
      Stream.catch((error: ProviderError) => {
        if (state.content.length === 0) return Stream.fail(error)
        state.finish_reason ??= "stop"
        return Stream.empty
      }),
    )

    return Stream.make(start).pipe(
      Stream.concat(body),
      Stream.concat(Stream.sync(() => responseCompletedFromState(request, state))),
    )
  })

const emptyContext = (): Context.Context<unknown> => Context.makeUnsafe(new Map())

export const promptFromMessages = (messages: ReadonlyArray<Message>): Prompt.RawInput =>
  messages.map((message): Prompt.MessageEncoded => {
    switch (message.role) {
      case "system":
      case "developer":
        return { role: "system", content: message.content }
      case "assistant":
        return { role: "assistant", content: message.content }
      case "tool":
      case "user":
        return { role: "user", content: message.content }
    }
    return { role: "user", content: message.content }
  })

export const responseFromGenerateText = (
  request: GenerateRequest,
  response: LanguageModel.GenerateTextResponse<any>,
): GenerateResponse =>
  responseFromParts(request, response.text, finishReasonFromAi(response.finishReason), usageFromAi(response.usage))

export const streamEventsFromAiPart = (
  part: Response.StreamPart<any>,
  state: StreamState,
): ReadonlyArray<StreamEvent> => {
  switch (part.type) {
    case "text-delta": {
      if (part.delta.length === 0) return []
      state.content += part.delta
      return [{ type: "content.delta", text: part.delta }]
    }
    case "reasoning-delta": {
      if (part.delta.length === 0) return []
      return [{ type: "reasoning.delta", text: part.delta }]
    }
    case "tool-params-start": {
      const name = part.name
      state.toolInputs.set(part.id, { name, input_text: "" })
      return [{ type: "tool.input.started", id: part.id, name }]
    }
    case "tool-params-delta": {
      const existing = state.toolInputs.get(part.id)
      if (existing !== undefined) {
        state.toolInputs.set(part.id, { ...existing, input_text: existing.input_text + part.delta })
      }
      return part.delta.length === 0 ? [] : [{ type: "tool.input.delta", id: part.id, text: part.delta }]
    }
    case "tool-params-end": {
      const existing = state.toolInputs.get(part.id)
      if (existing === undefined) return []
      return [{ type: "tool.input.ended", id: part.id, name: existing.name, input_text: existing.input_text }]
    }
    case "tool-call":
      return [{ type: "tool.call", id: part.id, name: part.name, input: part.params }]
    case "tool-result":
      return [
        {
          type: "tool.result",
          id: part.id,
          name: part.name,
          result: part.result,
          is_failure: part.isFailure,
        },
      ]
    case "finish": {
      state.finish_reason = finishReasonFromAi(part.reason)
      state.usage = usageFromAi(part.usage)
      return []
    }
    default:
      return []
  }
}

export const streamEventsFromResponse = (response: GenerateResponse): ReadonlyArray<StreamEvent> => {
  const events: Array<StreamEvent> = [{ type: "response.started", provider: response.provider, model: response.model }]
  if (response.content.length > 0) events.push({ type: "content.delta", text: response.content })
  events.push({ type: "response.completed", response })
  return events
}

export const finishReasonFromAi = (reason: Response.FinishReason): FinishReason =>
  reason === "tool-calls" ? "tool-call" : reason === "pause" || reason === "other" ? "unknown" : reason

export const usageFromAi = (usage: Response.Usage): Usage => ({
  ...(usage.inputTokens.total === undefined ? {} : { input_tokens: usage.inputTokens.total }),
  ...(usage.outputTokens.total === undefined ? {} : { output_tokens: usage.outputTokens.total }),
  ...(usage.outputTokens.reasoning === undefined ? {} : { reasoning_tokens: usage.outputTokens.reasoning }),
  ...(usage.inputTokens.total === undefined && usage.outputTokens.total === undefined
    ? {}
    : { total_tokens: (usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0) }),
})

const responseAt = (responses: ReadonlyArray<FakeResponse>, index: number): FakeResponse => {
  if (responses.length === 0) return "fake response"
  return responses[Math.min(index, responses.length - 1)] ?? "fake response"
}

const normalizeFakeResponse = (
  response: FakeResponse,
): Pick<GenerateResponse, "content" | "finish_reason" | "usage"> => {
  if (isFakeToolCallResponse(response)) {
    return {
      content: response.content ?? "",
      finish_reason: "tool-call",
    }
  }

  if (typeof response === "string") {
    return {
      content: response,
      finish_reason: "stop",
    }
  }

  return {
    content: response.content,
    ...(response.finish_reason === undefined ? {} : { finish_reason: response.finish_reason }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
  }
}

interface StreamState {
  content: string
  toolInputs: Map<string, { readonly name: string; readonly input_text: string }>
  finish_reason?: FinishReason
  usage?: Usage
}

const responseCompletedFromState = (request: GenerateRequest, state: StreamState): ResponseCompleted => ({
  type: "response.completed",
  response: responseFromParts(request, state.content, state.finish_reason ?? "unknown", state.usage),
})

const responseFromParts = (
  request: GenerateRequest,
  content: string,
  finishReason: FinishReason,
  usage: Usage | undefined,
): GenerateResponse => ({
  provider: request.provider,
  model: request.model,
  content,
  finish_reason: finishReason,
  ...(usage === undefined || !hasUsage(usage) ? {} : { usage }),
})

const hasUsage = (usage: Usage) =>
  usage.input_tokens !== undefined ||
  usage.output_tokens !== undefined ||
  usage.reasoning_tokens !== undefined ||
  usage.total_tokens !== undefined

const finishReasonToAi = (reason: FinishReason): Response.FinishReason =>
  reason === "tool-call" ? "tool-calls" : reason

const emptyAiUsage = () => ({
  inputTokens: {
    uncached: undefined,
    total: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
})

const aiUsageFromUsage = (usage: Usage | undefined) => {
  const empty = emptyAiUsage()
  if (usage === undefined) return empty
  return {
    inputTokens: {
      ...empty.inputTokens,
      total: usage.input_tokens,
    },
    outputTokens: {
      ...empty.outputTokens,
      total: usage.output_tokens,
      reasoning: usage.reasoning_tokens,
    },
  }
}

const aiPartsFromFakeResponse = (response: FakeResponse): ReadonlyArray<Response.PartEncoded> => {
  if (isFakeToolCallResponse(response)) {
    const id = response.id ?? "fake_tool_call"
    const textParts: Array<Response.PartEncoded> =
      response.content === undefined || response.content.length === 0
        ? []
        : [{ type: "text", text: response.content }]
    return [
      ...textParts,
      { type: "tool-call", id, name: response.name, params: response.input },
      {
        type: "finish",
        reason: "tool-calls",
        usage: aiUsageFromUsage(undefined),
        response: undefined,
      },
    ]
  }

  const normalized = normalizeFakeResponse(response)
  return [
    { type: "text", text: normalized.content },
    {
      type: "finish",
      reason: finishReasonToAi(normalized.finish_reason ?? "stop"),
      usage: aiUsageFromUsage(normalized.usage),
      response: undefined,
    },
  ]
}

const aiStreamPartsFromFakeResponse = (response: FakeResponse): ReadonlyArray<Response.StreamPartEncoded> => {
  if (isFakeToolCallResponse(response)) {
    const id = response.id ?? "fake_tool_call"
    const inputText = response.input_text ?? JSON.stringify(response.input)
    const textParts: Array<Response.StreamPartEncoded> =
      response.content === undefined || response.content.length === 0
        ? []
        : [
            { type: "text-start", id: "fake-text" },
            { type: "text-delta", id: "fake-text", delta: response.content },
            { type: "text-end", id: "fake-text" },
          ]
    const resultParts: Array<Response.StreamPartEncoded> =
      response.result === undefined
        ? []
        : [
            {
              type: "tool-result",
              id,
              name: response.name,
              result: response.result,
              isFailure: response.is_failure ?? false,
              providerExecuted: false,
              preliminary: false,
            },
          ]
    return [
      ...textParts,
      { type: "tool-params-start", id, name: response.name },
      { type: "tool-params-delta", id, delta: inputText },
      { type: "tool-params-end", id },
      { type: "tool-call", id, name: response.name, params: response.input },
      ...resultParts,
      {
        type: "finish",
        reason: "tool-calls",
        usage: aiUsageFromUsage(undefined),
        response: undefined,
      },
    ]
  }

  const normalized = normalizeFakeResponse(response)
  return [
    { type: "text-start", id: "fake-text" },
    { type: "text-delta", id: "fake-text", delta: normalized.content },
    { type: "text-end", id: "fake-text" },
    {
      type: "finish",
      reason: finishReasonToAi(normalized.finish_reason ?? "stop"),
      usage: aiUsageFromUsage(normalized.usage),
      response: undefined,
    },
  ]
}

const isFakeToolCallResponse = (response: FakeResponse): response is FakeToolCallResponse =>
  typeof response === "object" && response !== null && "type" in response && response.type === "tool-call"
