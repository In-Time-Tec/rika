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

  it.effect("returns the original prompts when compaction is not needed", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([])
      const history = Prompt.fromMessages([message("history")])
      const prompt = Prompt.make("continue")
      const current = ContextCompaction.checkpoint("previous", "summary", "0")
      const result = yield* ContextCompaction.compact(
        { contextWindow: 100, reserveTokens: 20, keepRecentTokens: 10, toolOutputMaxBytes: 100 },
        {
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
    }),
  )

  it.effect("preserves the checkpoint during tool-output microcompaction", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([])
      const current = ContextCompaction.checkpoint("6", "existing", "0")
      const large = "abcdef".repeat(100)
      const result = yield* ContextCompaction.compact(
        { contextWindow: 10, reserveTokens: 0, keepRecentTokens: 1, toolOutputMaxBytes: 12 },
        {
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
              ToolOutput.testLayer({ put: () => Effect.succeed(Option.some("memory:tool-output")) }),
            ),
          ),
        ),
      )
      expect(result.checkpoint).toEqual(current)
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(result.prompt.content)).toContain(
        "memory:tool-output",
      )
    }),
  )
})
