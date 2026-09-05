import { expect, it } from "vitest"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as InteractiveController from "../../../../src/interactive/controller/service"
import { thread, initialState } from "../feed.fixture"

const turn = (id: string, status: ThreadView.ThreadViewTurnRecord["status"]): ThreadView.ThreadViewTurn => ({
  turn: {
    kind: "agent",
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    status,
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 1,
  },
  projectionRevision: 0,
  usage: ExecutionProjection.emptyUsageState(),
  units: [],
})

const snapshot = (
  revision: number,
  turns: ReadonlyArray<ThreadView.ThreadViewTurn>,
): ThreadView.ThreadViewSnapshot => ({
  thread,
  revision,
  source: { projectionVersion: 1 },
  turns,
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})

it("settles an earlier submitted draft when cancellation promotes the next Turn", () => {
  let state = initialState()
  state = {
    ...state,
    model: {
      ...state.model,
      currentThreadId: String(thread.id),
      activeTurnId: "first",
      busy: true,
      cancelPending: true,
      submittedDrafts: [
        { input: "first", attachments: [], cursor: 5, submissionId: "submit-first", turnId: "first" },
        { input: "second", attachments: [], cursor: 6, submissionId: "submit-second", turnId: "second" },
      ],
    },
  }
  state = InteractiveController.update(state, {
    _tag: "ThreadViewSnapshot",
    snapshot: snapshot(1, [turn("first", "cancelled"), turn("second", "running")]),
  }).state
  expect(state.model.activeTurnId).toBe("second")
  expect(state.model.submittedDrafts.map((draft) => draft.turnId)).toEqual(["second"])
  expect(state.model.cancelPending).toBe(false)
  state = InteractiveController.update(state, {
    _tag: "ThreadViewSnapshot",
    snapshot: snapshot(2, [turn("first", "cancelled"), turn("second", "failed")]),
  }).state
  expect(state.model.submittedDrafts).toEqual([])
  expect(state.model.busy).toBe(false)
  expect(state.model.activity).toBeUndefined()
})

it.each(["snapshot", "patch"] as const)("%s replaces stale Finishing with Waiting without live activity", (kind) => {
  const active = {
    ...turn("active", "running"),
    units: [
      {
        key: "answer",
        turnId: "active",
        order: TranscriptOrdering.unitOrder("answer", 1),
        revision: 1,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: "Earlier answer" },
      },
    ],
  }
  let state = InteractiveController.update(initialState(), {
    _tag: "ThreadViewSnapshot",
    snapshot: snapshot(1, [active]),
  }).state
  expect(state.model.activity).toEqual({ _tag: "Waiting" })
  state = {
    ...state,
    model: { ...state.model, activity: { _tag: "Finishing", previous: { _tag: "Streaming", bytes: 48 } } },
  }
  state = InteractiveController.update(
    state,
    kind === "snapshot"
      ? {
          _tag: "ThreadViewSnapshot",
          snapshot: snapshot(2, [active]),
        }
      : {
          _tag: "ThreadViewPatch",
          patch: { threadId: thread.id, baseRevision: 1, revision: 2, upsert: [], remove: [], turnChanges: [] },
        },
  ).state
  expect(state.model.busy).toBe(true)
  expect(state.model.activeTurnId).toBe("active")
  expect(state.model.activity).toEqual({ _tag: "Waiting" })
  expect(state.model.entries.some((entry) => entry.text === "Earlier answer")).toBe(true)
})
