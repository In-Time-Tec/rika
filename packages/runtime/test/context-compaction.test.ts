import { Session, ToolOutput } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { ContextCompaction } from "../src/index"

const message = (text: string) => Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] })
const toolResult = (text: string) =>
  Prompt.makeMessage("tool", {
    content: [Prompt.makePart("tool-result", { id: "call", name: "tool", isFailure: false, result: text })],
  })
const entry = (id: string, text: string): Session.MessageEntry => ({
  _tag: "Message",
  id,
  parentId: id === "0" ? null : "0",
  message: message(text),
})

describe("ContextCompaction", () => {
  it("produces the same checkpoint digest after restart at the same cursor", () => {
    const first = ContextCompaction.checkpoint("42", "structured summary", "entry-9")
    const restarted = ContextCompaction.checkpoint("42", "structured summary", "entry-9")
    expect(restarted).toEqual(first)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it("configures public Baton stages in tool-bound, suffix, structured-summary order", () => {
    const value = ContextCompaction.strategy({
      contextWindow: 100,
      reserveTokens: 20,
      keepRecentTokens: 30,
      toolOutputMaxBytes: 1_024,
    })
    expect(value.toolOutputMaxBytes).toBe(1_024)
    expect(value.keepRecentTokens).toBe(30)
    expect(value.shouldCompact({ contextTokens: 80, contextWindow: 100, reserveTokens: 20 })).toBe(false)
    expect(value.shouldCompact({ contextTokens: 81, contextWindow: 100, reserveTokens: 20 })).toBe(true)
  })

  it("replays Relay-owned checkpoints and prevents duplicate persistence after restart", () => {
    const value = ContextCompaction.checkpoint("42", "structured summary", "entry-9")
    const replayed = ContextCompaction.checkpointFromReplay([
      { cursor: "41" },
      { cursor: "42", metadata: ContextCompaction.relayMetadata(value) },
    ])
    expect(replayed).toEqual(value)
    expect(ContextCompaction.shouldPersistCheckpoint(replayed, value)).toBe(false)
    expect(
      ContextCompaction.shouldPersistCheckpoint(replayed, ContextCompaction.checkpoint("43", "next", "entry-10")),
    ).toBe(true)
  })

  it("ignores malformed and unrelated replay metadata", () => {
    expect(
      ContextCompaction.checkpointFromReplay([
        { cursor: "1", metadata: null },
        { cursor: "2", metadata: "invalid" },
        { cursor: "3", metadata: { kind: "other" } },
        { cursor: "4", metadata: { kind: "context-compaction", checkpoint: { digest: false } } },
      ]),
    ).toBeUndefined()
    expect(ContextCompaction.shouldPersistCheckpoint(undefined, ContextCompaction.checkpoint("1", "s", "0"))).toBe(true)
  })

  it("uses the newest valid checkpoint in replay order", () => {
    const first = ContextCompaction.checkpoint("1", "first", "entry-1")
    const second = ContextCompaction.checkpoint("2", "second", "entry-2")
    expect(
      ContextCompaction.checkpointFromReplay([
        { cursor: "1", metadata: ContextCompaction.relayMetadata(first) },
        { cursor: "2", metadata: ContextCompaction.relayMetadata(second) },
        { cursor: "3", metadata: { kind: "context-compaction", checkpoint: { digest: false } } },
      ]),
    ).toEqual(second)
  })

  it.effect("returns the original prompts when compaction is not needed", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([])
      const history = Prompt.fromMessages([message("history")])
      const prompt = Prompt.make("continue")
      const current = ContextCompaction.checkpoint("previous", "summary", "0")
      const result = yield* ContextCompaction.compact(
        { contextWindow: 100, reserveTokens: 20, keepRecentTokens: 10, toolOutputMaxBytes: 100 },
        {
          compactionId: "compaction-not-needed",
          agentName: "rika",
          sessionId: "session",
          turn: 1,
          history,
          prompt,
          path: [entry("0", "history")],
          contextTokens: 20,
          checkpoint: current,
        },
      ).pipe(Effect.provide(yield* Layer.build(fixture.layer)))
      expect(result).toEqual({ history, prompt, checkpoint: current })
    }),
  )

  it.effect("creates a deterministic checkpoint from structured compaction", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([
        TestModel.object({
          goal: "Finish runtime coverage",
          facts: ["Relay owns execution"],
          decisions: ["Keep public boundaries"],
          openQuestions: [],
          toolFindings: ["Tests are deterministic"],
        }),
      ])
      const result = yield* ContextCompaction.compact(
        { contextWindow: 10, reserveTokens: 0, keepRecentTokens: 1, toolOutputMaxBytes: 100 },
        {
          compactionId: "compaction-structured",
          agentName: "rika",
          sessionId: "session",
          turn: 7,
          history: Prompt.fromMessages([message("old"), message("recent")]),
          prompt: Prompt.make("continue"),
          path: [entry("0", "old"), entry("1", "recent")],
          contextTokens: 100,
        },
      ).pipe(Effect.provide(yield* Layer.build(fixture.layer)))
      expect(result.checkpoint).toMatchObject({ cursor: "7", firstKeptEntryId: "1" })
      expect(result.checkpoint?.summary).toContain("Finish runtime coverage")
      expect(result.prompt).toEqual(Prompt.make("continue"))
      const requests = yield* fixture.requests
      expect(requests).toHaveLength(1)
      expect(requests[0]?.operation).toBe("generateObject")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(requests[0]?.prompt.content)).toContain(
        "Summarize the conversation",
      )
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(requests[0]?.prompt.content)).toContain("old")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(requests[0]?.prompt.content)).not.toContain(
        "recent",
      )
    }),
  )

  it.effect("fails without publishing a checkpoint when the summary route fails", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([])
      const current = ContextCompaction.checkpoint("6", "existing", "0")
      const result = yield* Effect.exit(
        ContextCompaction.compact(
          { contextWindow: 10, reserveTokens: 0, keepRecentTokens: 1, toolOutputMaxBytes: 100 },
          {
            compactionId: "compaction-failure",
            agentName: "rika",
            sessionId: "session",
            turn: 7,
            history: Prompt.fromMessages([message("old"), message("recent")]),
            prompt: Prompt.make("continue"),
            path: [entry("0", "old"), entry("1", "recent")],
            contextTokens: 100,
            checkpoint: current,
          },
        ),
      ).pipe(Effect.provide(yield* Layer.build(fixture.layer)))
      expect(result._tag).toBe("Failure")
      expect(yield* fixture.requests).toHaveLength(1)
      expect(current).toEqual(ContextCompaction.checkpoint("6", "existing", "0"))
    }),
  )

  it.effect("preserves the checkpoint during tool-output microcompaction", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([])
      const current = ContextCompaction.checkpoint("6", "existing", "0")
      const large = "abcdef".repeat(100)
      let spilled: unknown
      const result = yield* ContextCompaction.compact(
        { contextWindow: 10, reserveTokens: 0, keepRecentTokens: 1, toolOutputMaxBytes: 12 },
        {
          compactionId: "compaction-microcompact",
          agentName: "rika",
          sessionId: "session",
          turn: 7,
          history: Prompt.empty,
          prompt: Prompt.fromMessages([toolResult(large)]),
          path: [],
          contextTokens: 100,
          checkpoint: current,
        },
      ).pipe(
        Effect.provide(
          yield* Layer.build(
            Layer.mergeAll(
              fixture.layer,
              ToolOutput.layerTest({
                put: (_toolCallId, content) => {
                  spilled = content
                  return Effect.succeed(Option.some("memory:tool-output"))
                },
              }),
            ),
          ),
        ),
      )
      expect(result.checkpoint).toEqual(current)
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(result.prompt.content)
      expect(encoded).toContain("memory:tool-output")
      expect(encoded).not.toContain(large)
      expect(spilled).toEqual({ result: large, encodedResult: large })
    }),
  )

  it.effect("bounds tool output inline without replacing the checkpoint when optional spill fails", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([])
      const current = ContextCompaction.checkpoint("6", "existing", "0")
      const large = "abcdef".repeat(100)
      const result = yield* Effect.exit(
        ContextCompaction.compact(
          { contextWindow: 10, reserveTokens: 0, keepRecentTokens: 1, toolOutputMaxBytes: 12 },
          {
            compactionId: "compaction-spill-failure",
            agentName: "rika",
            sessionId: "session",
            turn: 7,
            history: Prompt.empty,
            prompt: Prompt.fromMessages([toolResult(large)]),
            path: [],
            contextTokens: 100,
            checkpoint: current,
          },
        ),
      ).pipe(
        Effect.provide(
          yield* Layer.build(
            Layer.mergeAll(
              fixture.layer,
              ToolOutput.layerTest({
                put: () => Effect.fail(ToolOutput.ToolOutputError.make({ message: "spill failed" })),
              }),
            ),
          ),
        ),
      )
      expect(result._tag).toBe("Success")
      if (result._tag === "Failure") return
      expect(result.value.checkpoint).toEqual(current)
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(result.value.prompt.content)
      expect(encoded).not.toContain(large)
      expect(encoded).toContain('"outputPaths":[]')
      expect(current).toEqual(ContextCompaction.checkpoint("6", "existing", "0"))
      expect(yield* fixture.requests).toHaveLength(0)
    }),
  )
})
