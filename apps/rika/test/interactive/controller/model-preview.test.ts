import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { createTestRenderer } from "@opentui/core/testing"
import { Surface } from "@rika/terminal/opentui-surface"
import * as InteractiveController from "../../../src/interactive/controller/service"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TerminalState from "@rika/terminal/terminal-state"
import { formatActivity } from "@rika/terminal/terminal-message"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const thread: Thread.Thread = {
  id: threadId,
  workspace: "/workspace",
  title: "Thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const turn: ThreadView.ThreadViewTurnRecord = {
  kind: "agent",
  id: turnId,
  threadId,
  prompt: "prompt",
  status: "running",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const promptKey = "turn:user"
const snapshot = (): ThreadView.ThreadViewSnapshot => ({
  thread,
  revision: 0,
  source: { projectionVersion: 1 },
  turns: [
    {
      turn,
      projectionRevision: 0,
      usage: ExecutionProjection.emptyUsageState(),
      units: [
        {
          key: promptKey,
          turnId,
          order: TranscriptOrdering.unitOrder(promptKey, -1),
          revision: 0,
          content: { _tag: "Entry", role: "user", text: "prompt" },
        },
      ],
    },
  ],
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})
const preview = (
  revision: number,
  text: string,
  options: Partial<ExecutionGateway.ModelPreviewIdentity> = {},
  reasoning = "reasoning",
  offsets = { text: 0, reasoning: 0 },
): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
  { readonly _tag: "ExecutionModelPreviewChanged" }
> => ({
  _tag: "ExecutionModelPreviewChanged",
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreview",
    runId: "run",
    attemptFence: 1,
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt-1",
    attempt: 1,
    ...options,
    sequence: revision - 1,
    changes: [
      { channel: "reasoning", offset: offsets.reasoning, delta: reasoning },
      { channel: "text", offset: offsets.text, delta: text },
    ],
  },
})
const previewCleared = (
  generation = 1,
  options: { readonly runId?: string; readonly attemptFence?: number } = {},
): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
  { readonly _tag: "ExecutionModelPreviewChanged" }
> => ({
  _tag: "ExecutionModelPreviewChanged",
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreviewCleared",
    runId: options.runId ?? "run",
    attemptFence: options.attemptFence ?? 1,
    generation,
  },
})
const loaded = () =>
  InteractiveController.update(
    { model: TerminalState.initial("/workspace", "medium") },
    { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
  ).state
const assistantText = (state: InteractiveController.State): string | undefined =>
  state.model.entries.findLast((entry) => entry.role === "assistant")?.text
const ReasoningBlock = Schema.TaggedStruct("Reasoning", { text: Schema.String })
const TranscriptItemProjection = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Finite),
  parentId: Schema.optionalKey(Schema.String),
})
const transcriptItems = (state: InteractiveController.State) =>
  state.model.items.flatMap((item) => Option.toArray(Schema.decodeUnknownOption(TranscriptItemProjection)(item)))
const reasoningText = (state: InteractiveController.State): string | undefined =>
  state.model.blocks.flatMap((block) => Option.toArray(Schema.decodeUnknownOption(ReasoningBlock)(block))).at(-1)?.text
const ids = (state: InteractiveController.State): ReadonlyArray<string> =>
  transcriptItems(state).flatMap((item) => (item.id === undefined ? [] : [item.id]))
const runPreview = (state: InteractiveController.State, runId = "run") => state.modelPreview?.byRun.get(runId)

const timelineUnit = (key: string, content: TranscriptUnit.Unit["content"], revision = 1): TranscriptUnit.Unit => ({
  key,
  turnId,
  order: TranscriptOrdering.unitOrder(key, revision),
  revision,
  content,
})

const toolCall = (status: "running" | "complete" = "running"): TranscriptUnit.Unit["content"] => ({
  _tag: "Block",
  block: {
    _tag: "ToolCall",
    id: "tool",
    name: "read",
    input: "{}",
    status,
    presentation: {
      family: "explore",
      action: "read",
      activeLabel: "Reading",
      completeLabel: "Read",
    },
    detail: "file.ts",
    files: [],
  },
})

interface PatchOptions {
  readonly upsert?: ReadonlyArray<TranscriptUnit.Unit>
  readonly status?: ThreadView.ThreadViewTurnRecord["status"]
  readonly turnUsage?: ExecutionProjection.UsageState
  readonly threadUsage?: ExecutionProjection.UsageState
}

const applyPatch = (state: InteractiveController.State, options: PatchOptions): InteractiveController.State => {
  const view = state.view!
  const entry = view.turn(String(turnId))!
  const patchBase: Omit<ThreadView.ThreadViewPatch, "header"> = {
    threadId,
    baseRevision: view.revision,
    revision: view.revision + 1,
    upsert: options.upsert ?? [],
    remove: [],
    turnChanges:
      options.status === undefined && options.turnUsage === undefined
        ? []
        : [
            {
              _tag: "UpsertTurn",
              turn: {
                ...entry.turn,
                status: options.status ?? entry.turn.status,
                updatedAt: entry.turn.updatedAt + 1,
              },
              projectionRevision: entry.projectionRevision + 1,
              usage: options.turnUsage ?? entry.usage,
            },
          ],
  }
  const patch: ThreadView.ThreadViewPatch =
    options.threadUsage === undefined
      ? patchBase
      : {
          ...patchBase,
          header: {
            thread: view.thread,
            source: view.source,
            pending: view.pending,
            hasOlder: view.hasOlder,
            hasNewer: view.hasNewer,
            usage: { ...view.usage, state: options.threadUsage },
          },
        }
  return InteractiveController.update(state, { _tag: "ThreadViewPatch", patch }).state
}

describe("tentative model preview overlay", () => {
  it("reports appended reasoning and answer previews as thinking and streaming activity", () => {
    let state = InteractiveController.update(loaded(), preview(1, "", {}, "12345678")).state
    expect(state.model.activity).toEqual({ _tag: "Thinking", bytes: 8 })
    expect(formatActivity(state.model.activity)).toBe("Thinking 2 tok")

    state = InteractiveController.update(state, preview(2, "123456789012", {}, "", { text: 0, reasoning: 8 })).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 12 })
    expect(formatActivity(state.model.activity)).toBe("Streaming 3 tok")

    state = InteractiveController.update(state, preview(3, "3456", {}, "", { text: 12, reasoning: 8 })).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 16 })
    expect(formatActivity(state.model.activity)).toBe("Streaming 4 tok")
  })

  it("keeps concurrent child previews separate and attaches each answer to its subagent card", () => {
    const card = (id: string): TranscriptUnit.Unit["content"] => ({
      _tag: "Block",
      block: {
        _tag: "SubagentCard",
        id,
        name: "Task",
        prompt: id,
        promptTruncated: false,
        summary: "",
        status: "running",
        activity: [],
      },
    })
    let state = applyPatch(loaded(), {
      upsert: [timelineUnit("card-a", card("card-a")), timelineUnit("card-b", card("card-b"))],
    })
    state = InteractiveController.update(
      state,
      preview(1, "answer-a", { runId: "child-a", parentId: "card-a", modelCallId: "call-a" }, ""),
    ).state
    state = InteractiveController.update(
      state,
      preview(1, "answer-b", { runId: "child-b", parentId: "card-b", modelCallId: "call-b" }, ""),
    ).state

    expect(state.modelPreview?.byRun.size).toBe(2)
    expect(
      transcriptItems(state)
        .flatMap((item) => {
          if (item._tag !== "Entry" || item.parentId === undefined || item.index === undefined) return []
          const entry = state.model.entries[item.index]
          return entry?.role === "assistant" ? [{ text: entry.text, parentId: item.parentId }] : []
        })
        .toSorted((left, right) => left.text.localeCompare(right.text)),
    ).toEqual([
      { text: "answer-a", parentId: "card-a" },
      { text: "answer-b", parentId: "card-b" },
    ])
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 16 })
  })

  it("assembles true append frames beyond 4,096 characters across mixed channels", () => {
    let state = loaded()
    let textOffset = 0
    let reasoningOffset = 0
    const text = Array.from({ length: 50 }, (_, index) => `text-${index.toString().padStart(2, "0")}:${"x".repeat(90)}`)
    const reasoning = Array.from(
      { length: 50 },
      (_, index) => `why-${index.toString().padStart(2, "0")}:${"y".repeat(30)}`,
    )
    for (let sequence = 0; sequence < text.length; sequence += 1) {
      state = InteractiveController.update(
        state,
        preview(sequence + 1, text[sequence]!, {}, reasoning[sequence]!, {
          text: textOffset,
          reasoning: reasoningOffset,
        }),
      ).state
      textOffset += text[sequence]!.length
      reasoningOffset += reasoning[sequence]!.length
    }
    expect(runPreview(state)?.text).toBe(text.join(""))
    expect(runPreview(state)?.reasoning).toBe(reasoning.join(""))
    expect(runPreview(state)?.textBytes).toBeGreaterThan(4_096)
    expect(runPreview(state)?.sequence).toBe(49)
  })

  it("validates UTF-16 offsets independently from UTF-8 activity bytes", () => {
    let state = InteractiveController.update(loaded(), preview(1, "🙂", {}, "é")).state
    expect(runPreview(state)).toMatchObject({
      text: "🙂",
      textLength: 2,
      textBytes: 4,
      reasoning: "é",
      reasoningLength: 1,
      reasoningBytes: 2,
    })

    state = InteractiveController.update(state, preview(2, "界", {}, "", { text: 2, reasoning: 1 })).state
    expect(runPreview(state)).toMatchObject({ text: "🙂界", textLength: 3, textBytes: 7, incomplete: false })

    state = InteractiveController.update(state, preview(3, "wrong", {}, "", { text: 7, reasoning: 1 })).state
    expect(runPreview(state)).toMatchObject({ text: "", textLength: 0, textBytes: 0, incomplete: true })
    expect(assistantText(state)).toBeUndefined()
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("counts a non-BMP character split across frames as one UTF-8 scalar", () => {
    let state = InteractiveController.update(loaded(), preview(1, "\ud83d", {}, "")).state
    expect(runPreview(state)).toMatchObject({ textLength: 1, textBytes: 3 })

    state = InteractiveController.update(state, preview(2, "\ude42", {}, "", { text: 1, reasoning: 0 })).state
    expect(runPreview(state)).toMatchObject({ text: "🙂", textLength: 2, textBytes: 4, incomplete: false })
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 4 })
  })

  it("removes tentative output immediately when a preview sequence is missing", () => {
    let state = InteractiveController.update(loaded(), preview(1, "visible", {}, "")).state
    state = InteractiveController.update(state, preview(3, "after gap", {}, "", { text: 7, reasoning: 0 })).state

    expect(runPreview(state)).toMatchObject({ text: "", textLength: 0, incomplete: true, sequence: 2 })
    expect(assistantText(state)).toBeUndefined()
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("keeps a matching clear effective after an incomplete frame and rejects that attempt afterward", () => {
    let state = InteractiveController.update(loaded(), preview(1, "visible", {}, "")).state
    state = InteractiveController.update(state, preview(3, "after gap", {}, "", { text: 7, reasoning: 0 })).state
    state = InteractiveController.update(state, previewCleared()).state

    expect(runPreview(state)?.clearFence).toBe(1)
    const cleared = state
    expect(InteractiveController.update(state, previewCleared()).state).toBe(cleared)
    expect(InteractiveController.update(state, preview(4, "revived", {}, "", { text: 16, reasoning: 0 })).state).toBe(
      cleared,
    )

    state = InteractiveController.update(
      state,
      preview(1, "new fence", { attemptFence: 2, modelAttemptId: "attempt-2", attempt: 2 }, ""),
    ).state
    expect(assistantText(state)).toBe("new fence")
  })

  it("renders a committed assistant message once after TenetKit discards the frame on commit", () => {
    const text = "Breakage began at 2b8aabb."
    let state = InteractiveController.update(loaded(), preview(1, text, {}, "")).state
    expect(assistantText(state)).toBe(text)

    state = InteractiveController.update(state, previewCleared(0)).state
    state = applyPatch(state, {
      upsert: [timelineUnit("committed:answer", { _tag: "Entry", role: "assistant", text })],
    })

    expect(state.model.entries.filter((entry) => entry.role === "assistant" && entry.text === text)).toHaveLength(1)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("uses a synthetic overflow clear only to invalidate the current identity", () => {
    let state = InteractiveController.update(loaded(), preview(1, "before overflow", {}, "")).state
    state = InteractiveController.update(state, previewCleared(0)).state

    expect(runPreview(state)).toMatchObject({ text: "", incomplete: true })
    expect(runPreview(state)?.clearFence).toBeUndefined()
    const invalidated = state
    expect(
      InteractiveController.update(state, preview(2, "same identity", {}, "", { text: 15, reasoning: 0 })).state,
    ).toBe(invalidated)

    state = InteractiveController.update(
      state,
      preview(1, "next call", { modelCallId: "call-2", modelAttemptId: "attempt-2" }, ""),
    ).state
    expect(assistantText(state)).toBe("next call")
    expect(runPreview(state)?.incomplete).toBe(false)
  })

  it("accepts a distinct model-call identity at the same fence and retires the old identity", () => {
    let state = InteractiveController.update(loaded(), preview(1, "first call", {}, "")).state
    state = InteractiveController.update(
      state,
      preview(1, "second call", { modelCallId: "call-2", modelAttemptId: "attempt-2", attempt: 1 }, ""),
    ).state

    expect(assistantText(state)).toBe("second call")
    expect(runPreview(state)?.incomplete).toBe(false)
    const second = state
    expect(InteractiveController.update(state, preview(2, " stale", {}, "", { text: 10, reasoning: 0 })).state).toBe(
      second,
    )
  })

  it("rejects stale revisions and retired attempts", () => {
    let state = loaded()
    state = InteractiveController.update(state, preview(1, "current")).state
    state = InteractiveController.update(state, preview(1, "stale revision")).state
    expect(assistantText(state)).toBe("current")
    state = InteractiveController.update(
      state,
      preview(1, "new attempt", { attemptFence: 2, modelAttemptId: "attempt-2", attempt: 2 }),
    ).state
    expect(assistantText(state)).toBe("new attempt")
    state = InteractiveController.update(state, preview(99, "retired attempt")).state
    expect(assistantText(state)).toBe("new attempt")
  })

  it("keeps a second model-call preview across a delayed durable projection from the first call", () => {
    let state = InteractiveController.update(loaded(), preview(1, "first answer", {}, "first thought")).state
    state = InteractiveController.update(
      state,
      preview(1, "second answer", { turn: 1, modelCallId: "call-2", modelAttemptId: "attempt-2" }, "second thought"),
    ).state
    const second = state.modelPreview
    const priorUnits = [
      timelineUnit("first:reasoning", {
        _tag: "Block",
        block: { _tag: "Reasoning", text: "first durable thought" },
      }),
      timelineUnit("first:tool", toolCall()),
      timelineUnit("first:answer", { _tag: "Entry", role: "assistant", text: "first durable answer" }),
    ]
    state = applyPatch(state, { upsert: priorUnits })
    expect(state.modelPreview).toBe(second)
    expect(state.view?.snapshot().turns[0]?.units.map((unit) => unit.key)).toEqual(
      expect.arrayContaining(priorUnits.map((unit) => unit.key)),
    )
    expect(assistantText(state)).toBe("second answer")
    expect(reasoningText(state)).toBe("second thought")

    state = InteractiveController.update(
      state,
      preview(2, " revised", { turn: 1, modelCallId: "call-2", modelAttemptId: "attempt-2" }, " revised", {
        text: "second answer".length,
        reasoning: "second thought".length,
      }),
    ).state
    expect(runPreview(state)?.sequence).toBe(1)
    expect(runPreview(state)?.text).toBe("second answer revised")
    expect(runPreview(state)?.reasoning).toBe("second thought revised")
  })

  it.each([
    {
      name: "assistant text",
      content: { _tag: "Entry", role: "assistant", text: "durable text" } as const,
      previewText: "tentative text",
      previewReasoning: "",
    },
    {
      name: "reasoning",
      content: { _tag: "Block", block: { _tag: "Reasoning", text: "durable thought" } } as const,
      previewText: "",
      previewReasoning: "tentative thought",
    },
    {
      name: "tool-only output",
      content: toolCall(),
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "cell",
      content: {
        _tag: "Block",
        block: {
          _tag: "Cell",
          id: "cell",
          status: "running",
          visual: "ts",
          source: { text: "1 + 1", lines: 1 },
          output: { stdout: "", stderr: "" },
          calls: [],
          epoch: 1,
          notices: [],
          files: [],
        },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "subagent card",
      content: {
        _tag: "Block",
        block: {
          _tag: "SubagentCard",
          id: "child",
          name: "reviewer",
          prompt: "review",
          promptTruncated: false,
          summary: "Reviewing",
          status: "running",
          activity: [],
        },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "file-source notification",
      content: {
        _tag: "Block",
        block: { _tag: "Notification", title: "File source unavailable", detail: "file.ts" },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "model error",
      content: {
        _tag: "Block",
        block: { _tag: "Error", title: "Model failed", detail: "provider rejected the request" },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
  ])("keeps a live preview across a delayed $name unit", ({ name, content, previewText, previewReasoning }) => {
    let state = InteractiveController.update(loaded(), preview(1, previewText, {}, previewReasoning)).state
    const overlay = state.modelPreview
    const key = `new:${name}`
    state = applyPatch(state, { upsert: [timelineUnit(key, content)] })
    expect(state.view?.snapshot().turns[0]?.units.some((unit) => unit.key === key)).toBe(true)
    expect(state.modelPreview).toBe(overlay)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(true)
  })

  it("keeps the preview across same-key tool progress, ToolResult, usage, and non-terminal status patches", () => {
    const toolKey = "baseline:tool"
    let state = applyPatch(loaded(), { upsert: [timelineUnit(toolKey, toolCall())] })
    state = InteractiveController.update(state, preview(1, "still streaming", {}, "still thinking")).state
    const overlay = state.modelPreview

    state = applyPatch(state, { upsert: [timelineUnit(toolKey, toolCall("complete"), 2)] })
    expect(state.modelPreview).toBe(overlay)
    expect(assistantText(state)).toBe("still streaming")

    const resultKey = "tool:result"
    state = applyPatch(state, {
      upsert: [
        timelineUnit(resultKey, {
          _tag: "Block",
          block: { _tag: "ToolResult", id: "tool", output: "done", failed: false },
        }),
      ],
    })
    expect(state.view?.snapshot().turns[0]?.units.some((unit) => unit.key === resultKey)).toBe(true)
    expect(state.modelPreview).toBe(overlay)

    const usage = {
      ...ExecutionProjection.emptyUsageState(),
      costNanoUsd: 12,
      pricedAttempts: 1,
      active: { _tag: "Available" as const, accumulatedMillis: 5 },
    }
    state = applyPatch(state, { status: "waiting", turnUsage: usage, threadUsage: usage })
    expect(state.view?.turn(String(turnId))?.turn.status).toBe("waiting")
    expect(state.view?.usage.state.costNanoUsd).toBe(12)
    expect(state.modelPreview).toBe(overlay)
    expect(assistantText(state)).toBe("still streaming")
  })

  it.each(["completed", "failed", "cancelled"] as const)("clears on terminal %s status", (status) => {
    let state = InteractiveController.update(loaded(), preview(1, "tentative answer")).state
    expect(state.modelPreview).toBeDefined()
    state = applyPatch(state, { status })
    expect(state.view?.turn(String(turnId))?.turn.status).toBe(status)
    expect(state.modelPreview).toBeUndefined()
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("replaces tentative text and reasoning with durable semantic units", () => {
    let state = InteractiveController.update(loaded(), preview(1, "tentative answer", {}, "tentative thought")).state
    const reasoningKey = "turn:reasoning"
    const answerKey = "turn:answer"
    const patch: ThreadView.ThreadViewPatch = {
      threadId,
      baseRevision: 0,
      revision: 1,
      upsert: [
        {
          key: reasoningKey,
          turnId,
          order: TranscriptOrdering.unitOrder(reasoningKey, 1),
          revision: 1,
          content: { _tag: "Block", block: { _tag: "Reasoning", text: "durable thought" } },
        },
        {
          key: answerKey,
          turnId,
          order: TranscriptOrdering.unitOrder(answerKey, 2),
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "durable answer" },
        },
      ],
      remove: [],
      turnChanges: [
        {
          _tag: "UpsertTurn",
          turn: { ...turn, status: "completed", updatedAt: 2 },
          projectionRevision: 1,
          usage: ExecutionProjection.emptyUsageState(),
        },
      ],
    }
    state = InteractiveController.update(state, { _tag: "ThreadViewPatch", patch }).state
    expect(assistantText(state)).toBe("durable answer")
    expect(reasoningText(state)).toBe("durable thought")
    expect(state.model.entries.filter((entry) => entry.role === "assistant")).toHaveLength(1)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
    expect(state.modelPreview).toBeUndefined()
  })

  it("clears tentative rows on terminal control and ignores foreign turns", () => {
    const state = InteractiveController.update(loaded(), preview(1, "tentative")).state
    const foreign = InteractiveController.update(state, { ...preview(2, "foreign"), turnId: Turn.TurnId.make("other") })
    expect(foreign.state).toBe(state)
    const cleared = InteractiveController.clearPreview(state, String(turnId))
    expect(cleared.modelPreview).toBeUndefined()
    expect(ids(cleared).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("clears tentative rows when the durable view requires resynchronization", () => {
    const state = InteractiveController.update(loaded(), preview(1, "tentative")).state
    const update = InteractiveController.update(
      state,
      ThreadView.ResyncRequired.make({
        threadId,
        expectedRevision: 1,
        receivedBaseRevision: 2,
        currentRevision: 0,
      }),
    )
    expect(update.resync).toBe(true)
    expect(update.state.modelPreview).toBeUndefined()
    expect(ids(update.state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("clears tentative rows when a same-thread durable patch is rejected", () => {
    const state = InteractiveController.update(loaded(), preview(1, "tentative")).state
    const view = state.view!
    const update = InteractiveController.update(state, {
      _tag: "ThreadViewPatch",
      patch: {
        threadId,
        baseRevision: view.revision + 1,
        revision: view.revision + 2,
        upsert: [],
        remove: [],
        turnChanges: [],
      },
    })

    expect(update).toMatchObject({ resync: true, rejection: "revision" })
    expect(update.state.modelPreview).toBeUndefined()
    expect(ids(update.state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it.effect("normalizes a CRLF split across tentative frames as one newline", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 60, height: 20 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          surface.destroy()
          setup.renderer.destroy()
        }),
      )
      let state = InteractiveController.update(loaded(), preview(1, "line\r", {}, "")).state
      surface.update(state.model)
      state = InteractiveController.update(state, preview(2, "\nnext", {}, "", { text: 5, reasoning: 0 })).state
      surface.update(state.model)
      yield* Effect.tryPromise(() => setup.flush())

      const lines = setup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
      const line = lines.findIndex((value) => value === "line")
      expect(line).toBeGreaterThanOrEqual(0)
      expect(lines[line + 1]).toBe("next")
      expect(setup.captureCharFrame()).not.toContain("�")
    }),
  )

  it.effect(
    "reuses a bounded set of physical OpenTUI rows across preview revisions",
    () =>
      Effect.gen(function* () {
        const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 100, height: 30 }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            surface.destroy()
            setup.renderer.destroy()
          }),
        )
        let state = loaded()
        let textOffset = 0
        let reasoningOffset = 0
        let stableRow: ReturnType<typeof surface.transcriptDiagnostics>["rows"][number] | undefined
        let stableRowKey: string | undefined
        for (let revision = 1; revision <= 10_000; revision += 1) {
          const text = `answer ${revision} `
          const reasoning = revision === 1 ? "reasoning" : ""
          state = InteractiveController.update(
            state,
            preview(revision, text, {}, reasoning, { text: textOffset, reasoning: reasoningOffset }),
          ).state
          textOffset += text.length
          reasoningOffset += reasoning.length
          surface.update(state.model)
          if (revision === 5_000) {
            const halfway = surface.transcriptDiagnostics()
            const answerRows = halfway.keys
              .map((key, index) => ({ key, row: halfway.rows[index] }))
              .filter(({ key }) => key.includes(":assistant:body"))
            const stable = answerRows.at(-2)
            stableRow = stable?.row
            stableRowKey = stable?.key
          }
        }
        yield* Effect.tryPromise(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(state.model.items).toHaveLength(3)
        expect(runPreview(state)?.text).toContain("answer 10000")
        expect(diagnostics.rows.length).toBeLessThan(32)
        expect(diagnostics.mountedPhysicalRows).toBeLessThanOrEqual(1_265)
        const tentativeRows = diagnostics.keys
          .map((key, index) => ({ key, row: diagnostics.rows[index]! }))
          .filter(({ key }) => key.includes("tentative:"))
        expect(tentativeRows.length).toBeGreaterThan(0)
        expect(tentativeRows.every(({ row }) => !row.selectable)).toBe(true)
        expect(stableRowKey).toBeDefined()
        expect(diagnostics.rows[diagnostics.keys.indexOf(stableRowKey!)]).toBe(stableRow)
      }),
    { timeout: 60_000 },
  )
})
