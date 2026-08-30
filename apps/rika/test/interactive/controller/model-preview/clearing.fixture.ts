import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { createTestRenderer } from "@opentui/core/testing"
import { Surface } from "@rika/terminal/opentui-surface"
import * as InteractiveController from "../../../../src/interactive/controller/service"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
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

describe("tentative model preview overlay", () => {
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
