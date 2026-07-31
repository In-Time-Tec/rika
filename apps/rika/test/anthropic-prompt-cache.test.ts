import { describe, expect, it } from "@effect/vitest"
import { ModelRegistry } from "@batonfx/core"
import * as Anthropic from "@batonfx/providers/anthropic"
import { PromptCache } from "@rika/relay-execution/relay-execution-layer"
import { withStreamingOnlyModel } from "@rika/relay-execution/relay-execution-layer"
import { Config, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const CacheControl = Schema.Struct({ type: Schema.String })

const Block = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  cache_control: Schema.optionalKey(Schema.NullOr(CacheControl)),
})

const Request = Schema.Struct({
  system: Schema.optionalKey(Schema.Array(Block)),
  messages: Schema.optionalKey(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Array(Block) }))),
})

type Block = typeof Block.Type
type Request = typeof Request.Type

const decodeRequest = Schema.decodeSync(Schema.fromJsonString(Request))

const ephemeral = (block: Block) => block.cache_control?.type === "ephemeral"

const systemBlocks = (request: Request): ReadonlyArray<Block> => request.system ?? []

const blocks = (request: Request): ReadonlyArray<Block> => [
  ...systemBlocks(request),
  ...(request.messages ?? []).flatMap((message) => message.content),
]

const proxyBaseUrl = "https://switchboard-itt.up.railway.app"

const capturingProvider = (captured: Array<string>) =>
  Anthropic.layer({
    model: "claude-opus-4-5",
    registrationKey: "wire-probe",
    apiKey: Config.succeed(Redacted.make("test-key")),
    clientConfig: { apiUrl: Config.succeed(proxyBaseUrl) },
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const body = request.body
            if (body._tag === "Uint8Array") captured.push(new TextDecoder().decode(body.body))
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))
          }),
        ),
      ),
    ),
    Layer.orDie,
  )

const wrapping = {
  bare: (registration: ModelRegistry.Registration) => registration,
  cached: (registration: ModelRegistry.Registration) => PromptCache.withPromptCaching(registration),
  streamingOnly: (registration: ModelRegistry.Registration) =>
    withStreamingOnlyModel(PromptCache.withPromptCaching(registration)),
}

const capturedRequest = (
  wrap: (registration: ModelRegistry.Registration) => ModelRegistry.Registration,
  prompt: Prompt.Prompt,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const captured: Array<string> = []
    const provider = yield* Layer.buildWithScope(capturingProvider(captured), scope)
    const registrations = yield* ModelRegistry.registrations().pipe(Effect.provideContext(provider))
    const environment = yield* Layer.buildWithScope(wrap(registrations[0]!).layer, scope)
    yield* LanguageModel.LanguageModel.pipe(
      Effect.flatMap((model) => Effect.ignore(Stream.runDrain(model.streamText({ prompt })))),
      Effect.provideContext(environment),
    )
    return decodeRequest(captured[0]!)
  }).pipe(Effect.scoped)

const toolLoopPrompt = Prompt.fromMessages([
  Prompt.makeMessage("system", { content: "shared guidance" }),
  Prompt.makeMessage("system", { content: "workspace rules" }),
  Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "read the file" })] }),
  Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", { id: "call-1", name: "bash", params: { command: "ls" }, providerExecuted: false }),
    ],
  }),
  Prompt.makeMessage("tool", {
    content: [Prompt.makePart("tool-result", { id: "call-1", name: "bash", isFailure: false, result: { out: "a" } })],
  }),
  Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", {
        id: "call-2",
        name: "bash",
        params: { command: "cat a" },
        providerExecuted: false,
      }),
    ],
  }),
  Prompt.makeMessage("tool", {
    content: [Prompt.makePart("tool-result", { id: "call-2", name: "bash", isFailure: false, result: { out: "b" } })],
  }),
])

describe("anthropic prompt cache on the wire", () => {
  it.effect("emits cache_control on the last system block, which also caches the tool definitions ahead of it", () =>
    Effect.gen(function* () {
      const request = yield* capturedRequest(wrapping.cached, toolLoopPrompt)
      expect(systemBlocks(request)).toHaveLength(2)
      expect(ephemeral(systemBlocks(request)[0]!)).toBe(false)
      expect(ephemeral(systemBlocks(request)[1]!)).toBe(true)
    }),
  )

  it.effect("emits cache_control on tool_result blocks, which Anthropic honors unlike assistant blocks", () =>
    Effect.gen(function* () {
      const request = yield* capturedRequest(wrapping.cached, toolLoopPrompt)
      const toolResults = blocks(request).filter((block) => block.type === "tool_result")
      const toolUses = blocks(request).filter((block) => block.type === "tool_use")
      expect(toolResults).toHaveLength(2)
      expect(toolResults.filter(ephemeral)).toHaveLength(2)
      expect(toolUses).toHaveLength(2)
      expect(toolUses.filter(ephemeral)).toHaveLength(0)
    }),
  )

  it.effect("stamps exactly three cache_control blocks, staying under Anthropic's limit of four", () =>
    Effect.gen(function* () {
      const request = yield* capturedRequest(wrapping.cached, toolLoopPrompt)
      expect(blocks(request).filter(ephemeral)).toHaveLength(3)
    }),
  )

  it.effect("asks only for the five-minute tier, never sending a ttl the pricing split cannot report", () =>
    Effect.gen(function* () {
      const request = yield* capturedRequest(wrapping.cached, toolLoopPrompt)
      for (const block of blocks(request).filter(ephemeral)) expect(block.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("still reaches the wire when the streaming-only wrapper sits above prompt caching", () =>
    Effect.gen(function* () {
      const request = yield* capturedRequest(wrapping.streamingOnly, toolLoopPrompt)
      expect(blocks(request).filter(ephemeral)).toHaveLength(3)
      expect(ephemeral(systemBlocks(request)[1]!)).toBe(true)
    }),
  )

  it.effect("emits no cache_control at all without the decorator, so the assertions above cannot pass vacuously", () =>
    Effect.gen(function* () {
      const request = yield* capturedRequest(wrapping.bare, toolLoopPrompt)
      expect(blocks(request)).not.toHaveLength(0)
      expect(blocks(request).filter(ephemeral)).toHaveLength(0)
    }),
  )
})
