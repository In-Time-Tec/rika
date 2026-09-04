import { describe, expect, it } from "@effect/vitest"
import "./model-preview/clearing.fixture"
import "./model-preview/reconciliation.fixture"
import { Option, Schema } from "effect"
import { modelResponseId } from "@rika/product/execution-gateway"
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
const previewUsage = (
  outputTokens: { readonly total?: number; readonly text?: number; readonly reasoning?: number },
  options: Partial<ExecutionGateway.ModelPreviewIdentity> = {},
): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
  { readonly _tag: "ExecutionModelPreviewChanged" }
> => ({
  _tag: "ExecutionModelPreviewChanged",
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreviewUsage",
    runId: "run",
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt-1",
    attempt: 1,
    ...options,
    completedAt: 1,
    outputTokens,
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

const timelineUnit = (
  key: string,
  content: TranscriptUnit.Unit["content"],
  revision = 1,
  responseId?: string,
): TranscriptUnit.Unit => {
  const unit: TranscriptUnit.Unit = {
    key,
    turnId,
    order: TranscriptOrdering.unitOrder(key, revision),
    revision,
    content,
  }
  return responseId === undefined ? unit : { ...unit, modelResponseId: responseId }
}

const responseId = (options: Partial<ExecutionGateway.ModelPreviewIdentity> = {}) =>
  modelResponseId({
    runId: options.runId ?? "run",
    turn: options.turn ?? 0,
    modelCallId: options.modelCallId ?? "call",
    modelAttemptId: options.modelAttemptId ?? "attempt-1",
    attempt: options.attempt ?? 1,
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
  it("increases estimated Thinking and Streaming tokens as previews append", () => {
    let state = InteractiveController.update(loaded(), preview(1, "", {}, "12345678")).state
    expect(state.model.activity).toEqual({ _tag: "Thinking", bytes: 8 })
    expect(formatActivity(state.model.activity)).toBe("Thinking ~2 tok")

    state = InteractiveController.update(state, preview(2, "123456789012", {}, "", { text: 0, reasoning: 8 })).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 12 })
    expect(formatActivity(state.model.activity)).toBe("Streaming ~3 tok")

    state = InteractiveController.update(state, preview(3, "3456", {}, "", { text: 12, reasoning: 8 })).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 16 })
    expect(formatActivity(state.model.activity)).toBe("Streaming ~4 tok")
  })

  it("keeps displaying the live estimate when final provider usage arrives", () => {
    let state = InteractiveController.update(loaded(), preview(1, "", {}, "reasoning")).state
    expect(formatActivity(state.model.activity)).toBe("Thinking ~3 tok")

    state = InteractiveController.update(state, previewUsage({ total: 7, reasoning: 7 })).state
    expect(state.model.activity).toEqual({ _tag: "Thinking", bytes: 9 })
    expect(formatActivity(state.model.activity)).toBe("Thinking ~3 tok")

    const nextAttempt = { attemptFence: 2, modelCallId: "call-2", modelAttemptId: "attempt-2", attempt: 2 }
    state = InteractiveController.update(state, preview(1, "streamed answer", nextAttempt, "")).state
    expect(formatActivity(state.model.activity)).toBe("Streaming ~4 tok")

    state = InteractiveController.update(state, previewUsage({ total: 11, text: 11 }, nextAttempt)).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 15 })
    expect(formatActivity(state.model.activity)).toBe("Streaming ~4 tok")
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

  it("renders a committed assistant message once after Generalist discards the frame on commit", () => {
    const text = "Breakage began at 2b8aabb."
    let state = InteractiveController.update(loaded(), preview(1, text, {}, "")).state
    expect(assistantText(state)).toBe(text)

    state = InteractiveController.update(state, previewCleared(0)).state
    state = applyPatch(state, {
      upsert: [timelineUnit("committed:answer", { _tag: "Entry", role: "assistant", text }, 1, responseId())],
    })

    expect(state.model.entries.filter((entry) => entry.role === "assistant" && entry.text === text)).toHaveLength(1)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("holds the final answer across a commit-discard clear until its durable response arrives", () => {
    const text = "Breakage began at 2b8aabb."
    let state = InteractiveController.update(loaded(), preview(1, text, {}, "")).state
    expect(assistantText(state)).toBe(text)

    state = InteractiveController.update(state, previewCleared(0)).state
    expect(assistantText(state)).toBe(text)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(true)

    state = applyPatch(state, {
      upsert: [timelineUnit("committed:answer", { _tag: "Entry", role: "assistant", text }, 1, responseId())],
    })

    expect(state.model.entries.filter((entry) => entry.role === "assistant" && entry.text === text)).toHaveLength(1)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
    expect(state.model.activity).toEqual({
      _tag: "Finishing",
      previous: { _tag: "Streaming", bytes: text.length },
    })
    expect(formatActivity(state.model.activity)).toBe("Streaming ~7 tok")
  })

  it("rejects late same-identity frames while holding across a commit-discard clear", () => {
    const text = "held answer"
    let state = InteractiveController.update(loaded(), preview(1, text, {}, "")).state
    state = InteractiveController.update(state, previewCleared(0)).state
    const held = state
    expect(assistantText(state)).toBe(text)

    state = InteractiveController.update(
      state,
      preview(2, "straggler", {}, "", { text: text.length, reasoning: 0 }),
    ).state
    expect(state).toBe(held)
    expect(assistantText(state)).toBe(text)
  })

  it("keeps unchanged preview units mounted across durable patches", () => {
    let state = InteractiveController.update(loaded(), preview(1, "still streaming", {}, "")).state
    const entries = state.model.entries
    const blocks = state.model.blocks
    const items = state.model.items

    state = applyPatch(state, {})

    expect({
      entries: state.model.entries === entries,
      blocks: state.model.blocks === blocks,
      items: state.model.items === items,
    }).toEqual({ entries: true, blocks: true, items: true })
    expect(assistantText(state)).toBe("still streaming")
  })

  it("uses a synthetic overflow clear only to invalidate the current identity", () => {
    let state = InteractiveController.update(loaded(), preview(1, "before overflow", {}, "")).state
    state = InteractiveController.update(state, previewCleared(0)).state

    expect(runPreview(state)).toMatchObject({ text: "before overflow", incomplete: true })
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

describe("final answer handoff continuity", () => {
  const answer = "the final answer"
  const secondAnswer = "the second answer"
  const childAnswer = "child final answer"
  const rootAnswer = "root final answer"

  const identityFor = (options: Partial<ExecutionGateway.ModelPreviewIdentity> = {}): string =>
    JSON.stringify([
      options.runId ?? "run",
      options.attemptFence ?? 1,
      options.turn ?? 0,
      options.modelCallId ?? "call",
      options.modelAttemptId ?? "attempt-1",
      options.attempt ?? 1,
    ])

  const tentativeAssistantId = (options: Partial<ExecutionGateway.ModelPreviewIdentity> = {}): string =>
    `tentative:${String(turnId)}:${identityFor(options)}:assistant`

  const tentativeIds = (state: InteractiveController.State): ReadonlyArray<string> =>
    ids(state).filter((id) => id.startsWith("tentative:"))

  const viewUnitKeys = (state: InteractiveController.State): ReadonlyArray<string> =>
    state.view?.snapshot().turns.flatMap((entry) => entry.units.map((unit) => unit.key)) ?? []

  const hasDurable = (state: InteractiveController.State, key: string): boolean => viewUnitKeys(state).includes(key)

  const answerCount = (state: InteractiveController.State, text: string): number =>
    state.model.entries.filter((entry) => entry.role === "assistant" && entry.text === text).length

  const subagentCard = (id: string): TranscriptUnit.Unit["content"] => ({
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

  const errorContent = (detail: string): TranscriptUnit.Unit["content"] => ({
    _tag: "Block",
    block: { _tag: "Error", title: "Model failed", detail },
  })

  interface HandoffStep {
    readonly label: string;
    readonly apply: (state: InteractiveController.State) => InteractiveController.State;
    readonly expectUnchanged?: boolean;
    readonly terminal?: boolean;
    readonly probe?: { readonly text: string; readonly options?: Partial<ExecutionGateway.ModelPreviewIdentity> };
  }

  interface TrackedAnswer {
    readonly text: string;
    readonly durableKey?: string;
    readonly options?: Partial<ExecutionGateway.ModelPreviewIdentity>;
    readonly absentLabels?: ReadonlyArray<string>;
  }

  interface HandoffOrder {
    readonly name: string;
    readonly kind: "success" | "terminal";
    readonly steps: ReadonlyArray<HandoffStep>;
    readonly answers: ReadonlyArray<TrackedAnswer>;
    readonly errorKey?: string;
  }

  interface Observation {
    readonly label: string;
    readonly state: InteractiveController.State;
    readonly tentative: ReadonlyArray<string>;
    readonly counts: Readonly<Record<string, number>>;
    readonly durableKeys: ReadonlyArray<string>;
    readonly retiredByRun: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly probe?: { readonly text: string; readonly options?: Partial<ExecutionGateway.ModelPreviewIdentity> };
    readonly terminal: boolean;
  }

  const showPreview = (
    label: string,
    text: string,
    options: Partial<ExecutionGateway.ModelPreviewIdentity> = {},
  ): HandoffStep => ({
    label,
    apply: (state) => InteractiveController.update(state, preview(1, text, options, "")).state,
  })

  const handoff = (runId = "run"): HandoffStep => ({
    label: runId === "run" ? "commit-handoff" : `commit-handoff ${runId}`,
    apply: (state) => InteractiveController.update(state, previewCleared(0, { runId })).state,
  })

  const durableAnswer = (
    label: string,
    key: string,
    text: string,
    options: Partial<ExecutionGateway.ModelPreviewIdentity> = {},
  ): HandoffStep => ({
    label,
    apply: (state) =>
      applyPatch(state, {
        upsert: [timelineUnit(key, { _tag: "Entry", role: "assistant", text }, 1, responseId(options))],
      }),
  })

  const statusStep = (label: string, status: ThreadView.ThreadViewTurnRecord["status"]): HandoffStep => ({
    label,
    terminal: status !== "waiting",
    apply: (state) => applyPatch(state, { status }),
  })

  const failedStep = (label: string, key: string): HandoffStep => ({
    label,
    terminal: true,
    apply: (state) =>
      applyPatch(state, {
        status: "failed",
        upsert: [timelineUnit(key, errorContent("provider rejected the request"))],
      }),
  })

  const staleFrame = (label: string, text: string): HandoffStep => ({
    label,
    expectUnchanged: true,
    apply: (state) =>
      InteractiveController.update(state, preview(2, `${text} straggler`, {}, "", { text: text.length, reasoning: 0 }))
        .state,
  })

  const lateFrame = (
    label: string,
    text: string,
    options: Partial<ExecutionGateway.ModelPreviewIdentity> = {},
  ): HandoffStep => ({
    label,
    probe: { text, options },
    apply: (state) => InteractiveController.update(state, preview(1, text, options, "")).state,
  })

  const childOptions = {
    runId: "child",
    parentId: "card-a",
    modelCallId: "call-child",
    modelAttemptId: "attempt-child",
  } as const

  const secondCallOptions = { modelCallId: "call-b", modelAttemptId: "attempt-b" } as const

  const orders: ReadonlyArray<HandoffOrder> = [
    {
      name: "preview -> commit-handoff -> durable patch -> completed",
      kind: "success",
      steps: [
        showPreview("preview", answer),
        handoff(),
        durableAnswer("durable patch", "durable:answer", answer),
        lateFrame("late frame", answer),
        statusStep("completed", "completed"),
      ],
      answers: [{ text: answer, durableKey: "durable:answer" }],
    },
    {
      name: "preview -> commit-handoff -> completed -> durable patch",
      kind: "success",
      steps: [
        showPreview("preview", answer),
        handoff(),
        statusStep("completed", "completed"),
        durableAnswer("durable patch", "durable:answer", answer),
        lateFrame("late frame", answer),
      ],
      answers: [{ text: answer, durableKey: "durable:answer" }],
    },
    {
      name: "preview -> completed -> commit-handoff -> durable patch",
      kind: "success",
      steps: [
        showPreview("preview", answer),
        statusStep("completed", "completed"),
        handoff(),
        durableAnswer("durable patch", "durable:answer", answer),
        lateFrame("late frame", answer),
      ],
      answers: [{ text: answer, durableKey: "durable:answer" }],
    },
    {
      name: "preview -> durable patch -> commit-handoff -> completed",
      kind: "success",
      steps: [
        showPreview("preview", answer),
        durableAnswer("durable patch", "durable:answer", answer),
        lateFrame("late frame", answer),
        handoff(),
        statusStep("completed", "completed"),
      ],
      answers: [{ text: answer, durableKey: "durable:answer" }],
    },
    {
      name: "preview -> commit-handoff -> stale preview frame -> durable patch",
      kind: "success",
      steps: [
        showPreview("preview", answer),
        handoff(),
        staleFrame("stale preview frame", answer),
        durableAnswer("durable patch", "durable:answer", answer),
        lateFrame("late frame", answer),
      ],
      answers: [{ text: answer, durableKey: "durable:answer" }],
    },
    {
      name: "preview A -> commit-handoff A -> preview B -> durable patch A",
      kind: "success",
      steps: [
        showPreview("preview A", answer),
        handoff(),
        showPreview("preview B", secondAnswer, secondCallOptions),
        durableAnswer("durable patch A", "durable:a", answer),
        lateFrame("late frame A", answer),
      ],
      answers: [
        { text: answer, durableKey: "durable:a", absentLabels: ["preview B"] },
        { text: secondAnswer, options: secondCallOptions },
      ],
    },
    {
      name: "preview -> failed",
      kind: "terminal",
      steps: [showPreview("preview", answer), failedStep("failed", "durable:error")],
      answers: [{ text: answer }],
      errorKey: "durable:error",
    },
    {
      name: "preview -> cancelled",
      kind: "terminal",
      steps: [showPreview("preview", answer), statusStep("cancelled", "cancelled")],
      answers: [{ text: answer }],
    },
    {
      name: "child preview -> root preview -> child durable -> root durable",
      kind: "success",
      steps: [
        {
          label: "stage card",
          apply: (state) => applyPatch(state, { upsert: [timelineUnit("card-a", subagentCard("card-a"))] }),
        },
        showPreview("child preview", childAnswer, childOptions),
        showPreview("root preview", rootAnswer),
        durableAnswer("child durable", "durable:child", childAnswer, childOptions),
        lateFrame("late frame child", childAnswer, childOptions),
        durableAnswer("root durable", "durable:root", rootAnswer),
        lateFrame("late frame root", rootAnswer),
      ],
      answers: [
        { text: childAnswer, durableKey: "durable:child", options: childOptions },
        { text: rootAnswer, durableKey: "durable:root" },
      ],
    },
  ]
  const checkSuccessAnswer = (
    order: HandoffOrder,
    answer: TrackedAnswer,
    observations: ReadonlyArray<Observation>,
    violations: Array<string>,
  ): void => {
    const key = tentativeAssistantId(answer.options ?? {})
    const runId = answer.options?.runId ?? "run"
    const firstSeen = observations.findIndex((observation) => (observation.counts[answer.text] ?? 0) > 0)
    if (firstSeen < 0) {
      violations.push(`[${order.name}] ${answer.text}: never became visible`)
      return
    }
    const firstDurable =
      answer.durableKey === undefined
        ? -1
        : observations.findIndex((observation) => observation.durableKeys.includes(answer.durableKey!))
    if (answer.durableKey !== undefined && firstDurable < 0)
      violations.push(`[${order.name}] ${answer.text}: durable ${answer.durableKey} never arrived`)
    observations.forEach((observation, index) => {
      if (index < firstSeen) return
      const tentative = observation.tentative.includes(key)
      const durable = answer.durableKey !== undefined && observation.durableKeys.includes(answer.durableKey)
      const count = observation.counts[answer.text] ?? 0
      if ((answer.absentLabels ?? []).includes(observation.label)) {
        if (tentative || durable || count !== 0)
          violations.push(
            `[${order.name}] ${observation.label}: expected ${answer.text} fully superseded, got tentative=${tentative} durable=${durable} count=${count}`,
          )
        return
      }
      if (count !== 1)
        violations.push(
          `[${order.name}] ${observation.label}: expected exactly one visible copy of ${answer.text}, got ${count}`,
        )
      if (!tentative && !durable)
        violations.push(
          `[${order.name}] ${observation.label}: intermediate state lacks both tentative and durable ${answer.text}`,
        )
      if (index === firstDurable) {
        if (tentative)
          violations.push(
            `[${order.name}] ${observation.label}: tentative ${answer.text} survived the transition that added durable output`,
          )
        const retired = observation.retiredByRun[runId] ?? []
        if (!retired.includes(identityFor(answer.options ?? {})))
          violations.push(
            `[${order.name}] ${observation.label}: durable ${answer.durableKey} did not retire tentative identity`,
          )
      }
    })
  }

  const checkProbe = (order: HandoffOrder, observation: Observation, violations: Array<string>): void => {
    if (observation.probe === undefined) return
    const key = tentativeAssistantId(observation.probe.options ?? {})
    if (observation.tentative.includes(key))
      violations.push(`[${order.name}] ${observation.label}: late frame revived tentative ${observation.probe.text}`)
    const count = observation.counts[observation.probe.text] ?? 0
    if (count !== 1)
      violations.push(
        `[${order.name}] ${observation.label}: late frame changed visible copies of ${observation.probe.text} to ${count}`,
      )
  }

  const checkTerminal = (
    order: HandoffOrder,
    observations: ReadonlyArray<Observation>,
    violations: Array<string>,
  ): void => {
    const terminalIndex = observations.findIndex((observation) => observation.terminal)
    observations.forEach((observation, index) => {
      if (terminalIndex >= 0 && index < terminalIndex) return
      if (terminalIndex < 0 && index < observations.length - 1) return
      const held = observation.tentative
      if (held.length > 0)
        violations.push(`[${order.name}] ${observation.label}: terminal state still holds tentative ${held.join(",")}`)
    })
    const final = observations.at(-1)!
    for (const answer of order.answers) {
      if ((final.counts[answer.text] ?? 0) !== 0)
        violations.push(`[${order.name}] final state still shows cleared ${answer.text}`)
    }
    if (order.errorKey !== undefined && !final.durableKeys.includes(order.errorKey))
      violations.push(`[${order.name}] durable error ${order.errorKey} is not visible`)
  }

  it("keeps a visible final answer continuous across every durable handoff order", () => {
    const failures: Array<string> = []
    for (const order of orders) {
      let state = loaded()
      const observations: Array<Observation> = []
      const violations: Array<string> = []
      for (const step of order.steps) {
        const before = state
        state = step.apply(state)
        const texts = [
          ...order.answers.map((entry) => entry.text),
          ...order.steps.flatMap((candidate) => (candidate.probe === undefined ? [] : [candidate.probe.text])),
        ]
        const counts: Record<string, number> = {}
        for (const text of texts) counts[text] = answerCount(state, text)
        const retiredByRun: Record<string, ReadonlyArray<string>> = {}
        for (const [runId, run] of state.modelPreview?.byRun ?? []) retiredByRun[runId] = run.retiredIdentities
        observations.push({
          label: step.label,
          state,
          tentative: tentativeIds(state),
          counts,
          durableKeys: viewUnitKeys(state),
          retiredByRun,
          probe: step.probe,
          terminal: step.terminal ?? false,
        })
        if (step.expectUnchanged === true && state !== before)
          violations.push(`[${order.name}] ${step.label}: expected no state change while held`)
      }
      if (order.kind === "success") {
        for (const answer of order.answers) checkSuccessAnswer(order, answer, observations, violations)
        for (const observation of observations) checkProbe(order, observation, violations)
      } else {
        checkTerminal(order, observations, violations)
      }
      failures.push(...violations)
    }
    expect(failures).toEqual([])
  })

  it("clears a held preview immediately on failure or cancellation", () => {
    for (const status of ["failed", "cancelled"] as const) {
      let state = InteractiveController.update(loaded(), preview(1, answer, {}, "")).state
      state = InteractiveController.update(state, previewCleared(0)).state
      expect(assistantText(state)).toBe(answer)
      expect(tentativeIds(state)).toHaveLength(1)

      state =
        status === "failed"
          ? applyPatch(state, {
              status,
              upsert: [timelineUnit("durable:error", errorContent("provider rejected the request"))],
            })
          : applyPatch(state, { status })

      expect(state.modelPreview).toBeUndefined()
      expect(tentativeIds(state)).toHaveLength(0)
      expect(answerCount(state, answer)).toBe(0)
      if (status === "failed") expect(hasDurable(state, "durable:error")).toBe(true)

      const settled = state
      state = InteractiveController.update(state, preview(1, answer, {}, "")).state
      expect(state).toBe(settled)
    }
  })

  it("does not clear a held preview on completed status alone", () => {
    let state = InteractiveController.update(loaded(), preview(1, answer, {}, "")).state
    state = InteractiveController.update(state, previewCleared(0)).state
    expect(assistantText(state)).toBe(answer)

    state = applyPatch(state, { status: "completed" })

    expect(state.modelPreview).toBeDefined()
    expect(assistantText(state)).toBe(answer)
    expect(ids(state)).toContain(tentativeAssistantId())

    state = applyPatch(state, {
      upsert: [timelineUnit("durable:answer", { _tag: "Entry", role: "assistant", text: answer }, 1, responseId())],
    })

    expect(answerCount(state, answer)).toBe(1)
    expect(tentativeIds(state)).toHaveLength(0)
  })

  it("rejects a durable model response without modelResponseId", () => {
    let state = InteractiveController.update(loaded(), preview(1, answer, {}, "")).state
    state = InteractiveController.update(state, previewCleared(0)).state
    expect(assistantText(state)).toBe(answer)

    const view = state.view!
    const update = InteractiveController.update(state, {
      _tag: "ThreadViewPatch",
      patch: {
        threadId,
        baseRevision: view.revision,
        revision: view.revision + 1,
        upsert: [timelineUnit("durable:answer", { _tag: "Entry", role: "assistant", text: answer })],
        remove: [],
        turnChanges: [],
      },
    })

    expect(update.resync).toBe(true)
    expect(assistantText(update.state)).toBe(answer)
    expect(tentativeIds(update.state)).toHaveLength(1)
    expect(answerCount(update.state, answer)).toBe(1)
  })
})
