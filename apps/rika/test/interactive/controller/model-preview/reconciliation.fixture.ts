import { Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as InteractiveController from "../../../../src/interactive/controller/service"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TerminalState from "@rika/terminal/terminal-state"

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

const timelineUnit = (
  key: string,
  content: TranscriptUnit.Unit["content"],
  revision = 1,
  modelResponseId?: string,
): TranscriptUnit.Unit => {
  const unit: TranscriptUnit.Unit = {
    key,
    turnId,
    order: TranscriptOrdering.unitOrder(key, revision),
    revision,
    content,
  }
  return modelResponseId === undefined ? unit : { ...unit, modelResponseId }
}

const responseId = (options: Partial<ExecutionGateway.ModelPreviewIdentity> = {}) =>
  ExecutionGateway.modelResponseId({
    runId: options.runId ?? "run",
    turn: options.turn ?? 0,
    modelCallId: options.modelCallId ?? "call",
    modelAttemptId: options.modelAttemptId ?? "attempt-1",
    attempt: options.attempt ?? 1,
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
  it("replaces a matching preview with its durable response without rendering both", () => {
    const text = "one visible answer"
    let state = InteractiveController.update(loaded(), preview(1, text, {}, "")).state

    state = applyPatch(state, {
      upsert: [timelineUnit("durable:answer", { _tag: "Entry", role: "assistant", text }, 1, responseId())],
    })

    expect(state.model.entries.filter((entry) => entry.role === "assistant" && entry.text === text)).toHaveLength(1)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
    expect(runPreview(state)).toMatchObject({ preview: undefined, identity: undefined, text: "", reasoning: "" })
  })

  it("retires only the matching call when an older durable response arrives late", () => {
    const secondIdentity = { turn: 1, modelCallId: "call-2", modelAttemptId: "attempt-2" }
    let state = InteractiveController.update(loaded(), preview(1, "first answer", {}, "")).state
    state = InteractiveController.update(state, preview(1, "second answer", secondIdentity, "")).state

    state = applyPatch(state, {
      upsert: [
        timelineUnit("durable:first", { _tag: "Entry", role: "assistant", text: "first answer" }, 1, responseId()),
      ],
    })

    expect(assistantText(state)).toBe("second answer")
    expect(runPreview(state)?.text).toBe("second answer")
    expect(ids(state).filter((id) => id.startsWith("tentative:"))).toHaveLength(1)
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
})
