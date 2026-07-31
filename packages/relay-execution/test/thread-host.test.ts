import { describe, expect, it } from "@effect/vitest"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Context, Effect, Layer, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import * as ThreadHost from "../src/thread-host"

const promptWith = (messages: ReadonlyArray<Prompt.MessageEncoded>) => Prompt.make(messages)

const pendingPayload = (threadId: string, generation: number, queueRevision: number) => ({
  kind: "queue-ready",
  thread_id: threadId,
  wake_generation: generation,
  queue_revision: queueRevision,
})

const waitBatch = (payloads: ReadonlyArray<Record<string, unknown>>) => ({
  status: "messages",
  messages: payloads.map((payload, sequence) => ({
    sequence,
    from: "address:rika",
    content: [{ type: "text", text: JSON.stringify(payload) }],
  })),
})

const waitResultMessage = (result: unknown): Prompt.MessageEncoded => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      id: "wait-0",
      name: ThreadHost.waitToolName,
      isFailure: false,
      result,
    },
  ],
})

const waitTool = Tool.make(ThreadHost.waitToolName, {
  description: "test stand-in for the relay inbox wait",
  parameters: Schema.Struct({}),
  success: Schema.Unknown,
})

describe("ThreadHost", () => {
  it.effect("parses the latest queue wake for each thread from the latest wait result", () =>
    Effect.sync(() => {
      const prompt = promptWith([
        { role: "user", content: [{ type: "text", text: "create" }] },
        waitResultMessage(
          waitBatch([
            pendingPayload("thread-a", 1, 4),
            pendingPayload("thread-a", 2, 5),
            pendingPayload("thread-b", 1, 3),
          ]),
        ),
      ])
      expect(ThreadHost.pendingQueueWakes(prompt)).toEqual([
        { threadId: "thread-a", generation: 2, queueRevision: 5 },
        { threadId: "thread-b", generation: 1, queueRevision: 3 },
      ])
    }),
  )

  it.effect("returns no thread ids without a trailing wait result", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(pendingPayload("t", 1, 1))
      expect(ThreadHost.pendingQueueWakes(promptWith([]))).toEqual([])
      expect(
        ThreadHost.pendingQueueWakes(promptWith([{ role: "user", content: [{ type: "text", text: encoded }] }])),
      ).toEqual([])
      expect(
        ThreadHost.pendingQueueWakes(promptWith([waitResultMessage({ status: "timed_out", messages: [] })])),
      ).toEqual([])
    }),
  )

  it.effect("waits for messages, promotes the delivered batch, and waits again", () =>
    Effect.gen(function* () {
      const crypto = yield* Layer.build(BunCrypto.layer)
      const registry = yield* ThreadHost.makeRegistry
      const promoted: Array<readonly [string, number]> = []
      yield* registry.register((threadId, generation) =>
        Effect.sync(() => {
          promoted.push([threadId, generation])
          return 2
        }),
      )
      const batch = waitBatch([pendingPayload("thread-a", 7, 12)])
      const toolkit = Toolkit.make(ThreadHost.promoteTurnTool, waitTool)
      const handlers = toolkit.toLayer({
        promote_turn: ({ threadId, generation }) =>
          registry.promote(threadId, generation).pipe(Effect.map((count) => ({ promoted: count }))),
        [ThreadHost.waitToolName]: () => Effect.succeed(batch),
      })
      const registration = yield* ThreadHost.hostRegistration.pipe(Effect.provide(crypto))
      const provideModel = Effect.provide(
        Context.merge(yield* Layer.build(Layer.merge(registration.layer, handlers)), crypto),
      )
      const parked = yield* LanguageModel.generateText({
        prompt: promptWith([{ role: "user", content: [{ type: "text", text: "create" }] }]),
        toolkit,
      }).pipe(provideModel)
      expect(parked.toolCalls.map((call) => call.name)).toEqual([ThreadHost.waitToolName])
      const woken = yield* LanguageModel.generateText({
        prompt: promptWith([{ role: "user", content: [{ type: "text", text: "create" }] }, waitResultMessage(batch)]),
        toolkit,
      }).pipe(provideModel)
      expect(woken.toolCalls.map((call) => call.name)).toEqual(["promote_turn"])
      expect(woken.toolCalls[0]?.params).toEqual({ threadId: "thread-a", generation: 7 })
      expect(woken.toolResults[0]?.result).toEqual({ promoted: 2 })
      expect(promoted).toEqual([["thread-a", 7]])
    }),
  )

  it.effect("uses distinct tool call ids after the host model is rebuilt", () =>
    Effect.gen(function* () {
      const crypto = yield* Layer.build(BunCrypto.layer)
      const toolkit = Toolkit.make(waitTool)
      const handlers = toolkit.toLayer({
        [ThreadHost.waitToolName]: () => Effect.succeed({ status: "timed_out", messages: [] }),
      })
      const runInitialCall = Effect.gen(function* () {
        const registration = yield* ThreadHost.hostRegistration.pipe(Effect.provide(crypto))
        return yield* LanguageModel.generateText({
          prompt: promptWith([{ role: "user", content: [{ type: "text", text: "create" }] }]),
          toolkit,
        }).pipe(Effect.provide(Context.merge(yield* Layer.build(Layer.merge(registration.layer, handlers)), crypto)))
      })

      const first = yield* runInitialCall
      const second = yield* runInitialCall

      expect(first.toolCalls[0]?.id).not.toBe(second.toolCalls[0]?.id)
    }),
  )

  it.effect("registry promotes through the registered promoter and defaults to zero", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadHost.makeRegistry
      expect(yield* registry.promote("thread-a", 1)).toBe(0)
      const promoted: Array<readonly [string, number]> = []
      yield* registry.register((threadId, generation) =>
        Effect.sync(() => {
          promoted.push([threadId, generation])
          return promoted.length
        }),
      )
      expect(yield* registry.promote("thread-a", 3)).toBe(1)
      expect(yield* registry.promote("thread-b", 4)).toBe(2)
      expect(promoted).toEqual([
        ["thread-a", 3],
        ["thread-b", 4],
      ])
    }),
  )
})
