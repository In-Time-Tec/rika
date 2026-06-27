import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as AiResponse from "effect/unstable/ai/Response"

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

export interface GenerateRequest extends Schema.Schema.Type<typeof GenerateRequest> {}
export const GenerateRequest = Schema.Struct({
  provider: ProviderName,
  model: ModelId,
  messages: Schema.Array(Message),
  reasoning_effort: Schema.optional(ReasoningEffort),
  max_output_tokens: Schema.optional(Schema.Int),
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.LLM.GenerateRequest" })

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

export interface ResponseCompleted extends Schema.Schema.Type<typeof ResponseCompleted> {}
export const ResponseCompleted = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: GenerateResponse,
}).annotate({ identifier: "Rika.LLM.StreamEvent.ResponseCompleted" })

export type StreamEvent = ResponseStarted | ContentDelta | ResponseCompleted
export const StreamEvent = Schema.Union([ResponseStarted, ContentDelta, ResponseCompleted]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Rika.LLM.StreamEvent" }),
)

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

export type FakeResponse = string | GenerateResponse

export interface FakeOptions {
  readonly name?: ProviderName
}

export const layer = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const languageModel = yield* LanguageModel.LanguageModel
      const providerName = yield* AiModel.ProviderName

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
  return layer().pipe(Layer.provide(fakeLanguageModelLayer(responses, { name: providerName })))
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
        const response = normalizeFakeResponse(responseAt(responses, nextIndex))
        nextIndex += 1
        return [...aiPartsFromFakeResponse(response)]
      }),
      streamText: () => {
        const response = normalizeFakeResponse(responseAt(responses, nextIndex))
        nextIndex += 1
        return Stream.fromIterable(aiStreamPartsFromFakeResponse(response))
      },
    }),
  )

  return Layer.mergeAll(Layer.succeed(AiModel.ProviderName, providerName), languageModelLayer)
}

export const completeWithLanguageModel = (languageModel: LanguageModel.Service, request: GenerateRequest) =>
  languageModel
    .generateText({ prompt: promptFromMessages(request.messages) })
    .pipe(Effect.map((response) => responseFromAiResponse(request, response)))

export const streamWithLanguageModel = (
  languageModel: LanguageModel.Service,
  request: GenerateRequest,
): Stream.Stream<StreamEvent, ProviderError> => {
  const state: StreamState = { content: "" }
  const start: ResponseStarted = { type: "response.started", provider: request.provider, model: request.model }
  const body = languageModel
    .streamText({ prompt: promptFromMessages(request.messages) })
    .pipe(Stream.flatMap((part) => Stream.fromIterable(streamEventsFromAiPart(part, state))))

  return Stream.make(start).pipe(
    Stream.concat(body),
    Stream.concat(Stream.sync(() => responseCompletedFromState(request, state))),
  )
}

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

export const responseFromAiResponse = (
  request: GenerateRequest,
  response: LanguageModel.GenerateTextResponse<Record<string, never>>,
): GenerateResponse =>
  responseFromParts(request, response.text, finishReasonFromAi(response.finishReason), usageFromAi(response.usage))

export const streamEventsFromAiPart = (
  part: AiResponse.StreamPart<Record<string, never>>,
  state: StreamState,
): ReadonlyArray<StreamEvent> => {
  switch (part.type) {
    case "text-delta": {
      if (part.delta.length === 0) return []
      state.content += part.delta
      return [{ type: "content.delta", text: part.delta }]
    }
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

export const finishReasonFromAi = (reason: AiResponse.FinishReason): FinishReason =>
  reason === "tool-calls" ? "tool-call" : reason === "pause" || reason === "other" ? "unknown" : reason

export const usageFromAi = (usage: AiResponse.Usage): Usage => ({
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

const finishReasonToAi = (reason: FinishReason): AiResponse.FinishReason =>
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

const aiPartsFromFakeResponse = (
  response: Pick<GenerateResponse, "content" | "finish_reason" | "usage">,
): ReadonlyArray<AiResponse.PartEncoded> => [
  { type: "text", text: response.content },
  {
    type: "finish",
    reason: finishReasonToAi(response.finish_reason ?? "stop"),
    usage: aiUsageFromUsage(response.usage),
    response: undefined,
  },
]

const aiStreamPartsFromFakeResponse = (
  response: Pick<GenerateResponse, "content" | "finish_reason" | "usage">,
): ReadonlyArray<AiResponse.StreamPartEncoded> => [
  { type: "text-start", id: "fake-text" },
  { type: "text-delta", id: "fake-text", delta: response.content },
  { type: "text-end", id: "fake-text" },
  {
    type: "finish",
    reason: finishReasonToAi(response.finish_reason ?? "stop"),
    usage: aiUsageFromUsage(response.usage),
    response: undefined,
  },
]
