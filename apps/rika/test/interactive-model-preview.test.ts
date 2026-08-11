import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createTestRenderer } from "@opentui/core/testing"
import { Surface } from "@rika/terminal/opentui-surface"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TerminalState from "@rika/terminal/terminal-state"
import type { TranscriptItem } from "@rika/terminal/terminal-message"

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
  options: Partial<ExecutionGateway.ModelPreviewed["key"]> = {},
  reasoning = "reasoning",
): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
  { readonly _tag: "ExecutionModelPreviewed" }
> => ({
  _tag: "ExecutionModelPreviewed",
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreviewed",
    key: {
      runId: "run",
      attemptFence: 1,
      turn: 0,
      modelCallId: "call",
      modelAttemptId: "attempt-1",
      attempt: 1,
      ...options,
    },
    revision,
    text,
    reasoning,
    truncated: false,
  },
})
const loaded = () =>
  InteractiveController.update(
    { model: TerminalState.initial("/workspace", "medium") },
    { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
  ).state
const assistantText = (state: InteractiveController.State): string | undefined =>
  state.model.entries.findLast((entry) => entry.role === "assistant")?.text
const reasoningText = (state: InteractiveController.State): string | undefined =>
  (state.model.blocks as ReadonlyArray<{ readonly _tag?: string; readonly text?: string }>).findLast(
    (block) => block._tag === "Reasoning",
  )?.text
const ids = (state: InteractiveController.State): ReadonlyArray<string> =>
  (state.model.items as ReadonlyArray<TranscriptItem>).flatMap((item) => (item.id === undefined ? [] : [item.id]))

describe("tentative model preview overlay", () => {
  it("keeps ten thousand cumulative revisions to two bounded native transcript units", () => {
    let state = loaded()
    for (let revision = 1; revision <= 10_000; revision += 1)
      state = InteractiveController.update(state, preview(revision, `answer ${revision}`)).state
    expect(assistantText(state)).toBe("answer 10000")
    expect(reasoningText(state)).toBe("reasoning")
    expect(state.modelPreview?.preview.revision).toBe(10_000)
    expect(state.model.items).toHaveLength(3)
    expect(ids(state).filter((id) => id.startsWith("tentative:"))).toHaveLength(2)
  })

  it("rejects stale revisions and retired attempts", () => {
    let state = loaded()
    state = InteractiveController.update(state, preview(2, "current")).state
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

  it.effect("reuses a bounded set of physical OpenTUI rows across preview revisions", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          surface.destroy()
          setup.renderer.destroy()
        }),
      )
      let state = InteractiveController.update(loaded(), preview(1, "answer 1")).state
      surface.update(state.model)
      const initialRows = [...surface.transcriptDiagnostics().rows]
      for (let revision = 2; revision <= 10_000; revision += 1) {
        state = InteractiveController.update(state, preview(revision, `answer ${revision}`)).state
        surface.update(state.model)
      }
      yield* Effect.promise(() => setup.flush())
      const diagnostics = surface.transcriptDiagnostics()
      expect(state.model.items).toHaveLength(3)
      expect(diagnostics.rows).toHaveLength(3)
      expect(diagnostics.rows).toEqual(initialRows)
      expect(diagnostics.mountedPhysicalRows).toBeLessThanOrEqual(3)
    }),
  )
})
