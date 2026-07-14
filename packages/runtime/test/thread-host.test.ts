import { describe, expect, it } from "@effect/vitest"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, Layer, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import * as ThreadHost from "../src/thread-host"

const promptWith = (messages: ReadonlyArray<Prompt.MessageEncoded>) => Prompt.make(messages)

const pendingPayload = (threadId: string, turnId: string) => ({
  kind: "pending-turn",
  thread_id: threadId,
  turn_id: turnId,
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
  it.effect("parses pending thread ids from the latest wait result", () =>
    Effect.sync(() => {
      const prompt = promptWith([
        { role: "user", content: [{ type: "text", text: "create" }] },
        waitResultMessage(
          waitBatch([
            pendingPayload("thread-a", "turn-1"),
            pendingPayload("thread-a", "turn-2"),
            pendingPayload("thread-b", "turn-3"),
          ]),
        ),
      ])
      expect(ThreadHost.pendingThreadIds(prompt)).toEqual(["thread-a", "thread-b"])
    }),
  )

  it.effect("returns no thread ids without a trailing wait result", () =>
    Effect.sync(() => {
      expect(ThreadHost.pendingThreadIds(promptWith([]))).toEqual([])
      expect(
        ThreadHost.pendingThreadIds(
          promptWith([{ role: "user", content: [{ type: "text", text: JSON.stringify(pendingPayload("t", "x")) }] }]),
        ),
      ).toEqual([])
      expect(
        ThreadHost.pendingThreadIds(promptWith([waitResultMessage({ status: "timed_out", messages: [] })])),
      ).toEqual([])
    }),
  )

  it.effect("waits for messages, promotes the delivered batch, and waits again", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadHost.makeRegistry
      const promoted: Array<string> = []
      yield* registry.register((threadId) =>
        Effect.sync(() => {
          promoted.push(threadId)
          return 2
        }),
      )
      const batch = waitBatch([pendingPayload("thread-a", "turn-1")])
      const toolkit = Toolkit.make(ThreadHost.promoteTurnTool, waitTool)
      const handlers = toolkit.toLayer({
        promote_turn: ({ threadId }) => registry.promote(threadId).pipe(Effect.map((count) => ({ promoted: count }))),
        [ThreadHost.waitToolName]: () => Effect.succeed(batch),
      })
      const registration = yield* ThreadHost.hostRegistration
      const provideModel = Effect.provide(Layer.merge(registration.layer, handlers))
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
      expect(woken.toolCalls[0]?.params).toEqual({ threadId: "thread-a" })
      expect(woken.toolResults[0]?.result).toEqual({ promoted: 2 })
      expect(promoted).toEqual(["thread-a"])
    }).pipe(Effect.provide(BunCrypto.layer)),
  )

  it.effect("uses distinct tool call ids after the host model is rebuilt", () =>
    Effect.gen(function* () {
      const toolkit = Toolkit.make(waitTool)
      const handlers = toolkit.toLayer({
        [ThreadHost.waitToolName]: () => Effect.succeed({ status: "timed_out", messages: [] }),
      })
      const runInitialCall = Effect.gen(function* () {
        const registration = yield* ThreadHost.hostRegistration
        return yield* LanguageModel.generateText({
          prompt: promptWith([{ role: "user", content: [{ type: "text", text: "create" }] }]),
          toolkit,
        }).pipe(Effect.provide(Layer.merge(registration.layer, handlers)))
      })

      const first = yield* runInitialCall
      const second = yield* runInitialCall

      expect(first.toolCalls[0]?.id).not.toBe(second.toolCalls[0]?.id)
    }).pipe(Effect.provide(BunCrypto.layer)),
  )

  it.effect("registry promotes through the registered promoter and defaults to zero", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadHost.makeRegistry
      expect(yield* registry.promote("thread-a")).toBe(0)
      const promoted: Array<string> = []
      yield* registry.register((threadId) =>
        Effect.sync(() => {
          promoted.push(threadId)
          return promoted.length
        }),
      )
      expect(yield* registry.promote("thread-a")).toBe(1)
      expect(yield* registry.promote("thread-b")).toBe(2)
      expect(promoted).toEqual(["thread-a", "thread-b"])
    }),
  )
})
