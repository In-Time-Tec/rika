import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import * as ThreadHost from "../src/thread-host"

const promptWith = (messages: ReadonlyArray<Prompt.MessageEncoded>) => Prompt.make(messages)

const pendingText = (threadId: string, turnId: string) =>
  JSON.stringify({ kind: "pending-turn", thread_id: threadId, turn_id: turnId })

describe("ThreadHost", () => {
  it.effect("parses pending thread ids from the final user message only", () =>
    Effect.sync(() => {
      const prompt = promptWith([
        { role: "user", content: [{ type: "text", text: pendingText("thread-old", "turn-old") }] },
        { role: "assistant", content: [{ type: "text", text: "parked" }] },
        {
          role: "user",
          content: [
            { type: "text", text: pendingText("thread-a", "turn-1") },
            { type: "text", text: pendingText("thread-a", "turn-2") },
            { type: "text", text: pendingText("thread-b", "turn-3") },
            { type: "text", text: "not json" },
          ],
        },
      ])
      expect(ThreadHost.pendingThreadIds(prompt)).toEqual(["thread-a", "thread-b"])
    }),
  )

  it.effect("returns no thread ids without a user message or payloads", () =>
    Effect.sync(() => {
      expect(ThreadHost.pendingThreadIds(promptWith([]))).toEqual([])
      expect(
        ThreadHost.pendingThreadIds(promptWith([{ role: "user", content: [{ type: "text", text: "hello" }] }])),
      ).toEqual([])
      expect(
        ThreadHost.pendingThreadIds(
          promptWith([{ role: "user", content: [{ type: "text", text: '{"kind":"pending-turn","thread_id":""}' }] }]),
        ),
      ).toEqual([])
    }),
  )

  it.effect("promotes a pending batch through promote_turn and parks otherwise", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadHost.makeRegistry
      const promoted: Array<string> = []
      yield* registry.register((threadId) =>
        Effect.sync(() => {
          promoted.push(threadId)
          return 2
        }),
      )
      const registration = yield* ThreadHost.hostRegistration
      const provideModel = Effect.provide(Layer.merge(registration.layer, ThreadHost.handlerLayer(registry)))
      const busy = yield* LanguageModel.generateText({
        prompt: promptWith([{ role: "user", content: [{ type: "text", text: pendingText("thread-a", "turn-1") }] }]),
        toolkit: ThreadHost.toolkit,
      }).pipe(provideModel)
      expect(busy.toolCalls).toHaveLength(1)
      expect(busy.toolCalls[0]?.name).toBe("promote_turn")
      expect(busy.toolCalls[0]?.params).toEqual({ threadId: "thread-a" })
      expect(busy.toolResults[0]?.result).toEqual({ promoted: 2 })
      expect(promoted).toEqual(["thread-a"])
      const idle = yield* LanguageModel.generateText({
        prompt: promptWith([
          { role: "user", content: [{ type: "text", text: pendingText("thread-a", "turn-1") }] },
          { role: "assistant", content: [{ type: "text", text: "working" }] },
        ]),
        toolkit: ThreadHost.toolkit,
      }).pipe(provideModel)
      expect(idle.toolCalls).toHaveLength(0)
      expect(idle.text).toBe("parked")
    }),
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
