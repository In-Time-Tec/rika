import { describe, expect, it } from "@effect/vitest"
import "./model-preview/clearing.fixture"
import "./model-preview/reconciliation.fixture"
import { Option, Schema } from "effect"
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
const TranscriptItemProjection = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Finite),
  parentId: Schema.optionalKey(Schema.String),
})
const transcriptItems = (state: InteractiveController.State) =>
  state.model.items.flatMap((item) => Option.toArray(Schema.decodeUnknownOption(TranscriptItemProjection)(item)))
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
        preview(sequence + 1, text[sequence]!, {}, reasoning[sequence], {
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
})
