import { ModelRegistry } from "@batonfx/core"
import { Ids } from "@relayfx/sdk"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"

export const hostAgentId = Ids.AgentId.make("agent:rika-thread-host")
export const entityKind = Ids.EntityKindName.make("rika-thread")
export const continueAsNewAfterTurns = 32
export const hostMaxWaitTurns = 1_000_000
export const hostSelection: ModelRegistry.ModelSelection = { provider: "rika", model: "thread-host" }

export class PromoteTurnError extends Schema.TaggedErrorClass<PromoteTurnError>()("PromoteTurnError", {
  message: Schema.String,
}) {}

export const promoteTurnTool = Tool.make("promote_turn", {
  description: "Claim and start every currently claimable queued Rika turn for a thread",
  parameters: Schema.Struct({ threadId: Schema.String }),
  success: Schema.Struct({ promoted: Schema.Number }),
  failure: PromoteTurnError,
  failureMode: "return",
})

export const toolkit = Toolkit.make(promoteTurnTool)

export type Promoter = (threadId: string) => Effect.Effect<number>

export interface RegistryInterface {
  readonly register: (promoter: Promoter) => Effect.Effect<void>
  readonly promote: (threadId: string) => Effect.Effect<number>
}

export class Registry extends Context.Service<Registry, RegistryInterface>()("@rika/runtime/ThreadHostRegistry") {}

export const makeRegistry: Effect.Effect<RegistryInterface> = Effect.gen(function* () {
  const slot = yield* Ref.make(Option.none<Promoter>())
  return Registry.of({
    register: (promoter) => Ref.set(slot, Option.some(promoter)),
    promote: (threadId) =>
      Ref.get(slot).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(0),
            onSome: (promoter) => promoter(threadId),
          }),
        ),
      ),
  })
})

export const handlerLayer = (registry: RegistryInterface) =>
  toolkit.toLayer({
    promote_turn: ({ threadId }) => registry.promote(threadId).pipe(Effect.map((promoted) => ({ promoted }))),
  })

export const pendingThreadIds = (prompt: Prompt.Prompt): ReadonlyArray<string> => {
  const last = prompt.content.findLast((message) => message.role === "user")
  if (last === undefined) return []
  const text = last.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const ids = new Set<string>()
  for (const match of text.matchAll(/\{[^{}]*"kind"\s*:\s*"pending-turn"[^{}]*\}/g)) {
    const payload = parseJson(match[0])
    if (payload !== undefined && typeof payload.thread_id === "string" && payload.thread_id.length > 0) {
      ids.add(payload.thread_id)
    }
  }
  return [...ids]
}

const parseJson = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const usage = (): Response.Usage =>
  new Response.Usage({
    inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  })

const finish = (reason: "stop" | "tool-calls"): Response.FinishPartEncoded => ({
  type: "finish",
  reason,
  usage: usage(),
  response: undefined,
})

const respond = (
  counter: Ref.Ref<number>,
  options: LanguageModel.ProviderOptions,
): Effect.Effect<Array<Response.PartEncoded>> =>
  Effect.gen(function* () {
    const request = yield* Ref.getAndUpdate(counter, (value) => value + 1)
    const lastMessage = options.prompt.content.at(-1)
    const threadIds = lastMessage?.role === "user" ? pendingThreadIds(options.prompt) : []
    if (threadIds.length === 0) {
      return [{ type: "text", text: "parked" }, finish("stop")]
    }
    return [
      ...threadIds.map(
        (threadId, index): Response.PartEncoded => ({
          type: "tool-call",
          id: `promote-${request}-${index}`,
          name: "promote_turn",
          params: { threadId },
          providerExecuted: false,
        }),
      ),
      finish("tool-calls"),
    ]
  })

const toStreamParts = (parts: Array<Response.PartEncoded>): Array<Response.StreamPartEncoded> =>
  parts.flatMap((part): Array<Response.StreamPartEncoded> => {
    if (part.type !== "text") return [part as Response.StreamPartEncoded]
    const id = "thread-host-text"
    return [
      { type: "text-start", id },
      { type: "text-delta", id, delta: part.text },
      { type: "text-end", id },
    ]
  })

export const hostRegistration: Effect.Effect<ModelRegistry.Registration> = Effect.gen(function* () {
  const counter = yield* Ref.make(0)
  const service = yield* LanguageModel.make({
    generateText: (options) => respond(counter, options),
    streamText: (options) =>
      Stream.unwrap(respond(counter, options).pipe(Effect.map((parts) => Stream.fromIterable(toStreamParts(parts))))),
  })
  return yield* ModelRegistry.registrationFromLayer({
    provider: hostSelection.provider,
    model: hostSelection.model,
    layer: Layer.succeed(LanguageModel.LanguageModel, service),
  })
})
