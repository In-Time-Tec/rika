import { describe, expect, it } from "vitest"
import "./thread-selection/projection.fixture"
import "./thread-selection/steering.fixture"
import * as InteractiveController from "../../../src/interactive/controller/service"
import * as ViewState from "@rika/terminal/terminal-state"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadView from "@rika/product/thread-view"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"

const snapshot = (threadId = Thread.ThreadId.make("thread"), revision = 4): ThreadView.ThreadViewSnapshot => ({
  thread: {
    id: threadId,
    workspace: "/workspace",
    title: "Thread",
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 1,
  },
  revision,
  source: { projectionVersion: 1 },
  turns: [],
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})

const state = (): InteractiveController.State => ({ model: ViewState.initial("/workspace", "medium") })

const patch = (changes: Partial<ThreadView.ThreadViewPatch> = {}): ThreadView.ThreadViewPatch => ({
  threadId: Thread.ThreadId.make("thread"),
  baseRevision: 4,
  revision: 5,
  upsert: [],
  remove: [],
  turnChanges: [],
  ...changes,
})

describe("interactive ThreadView controller", () => {
  it("applies only an exact-base patch", () => {
    const loaded = InteractiveController.update(state(), { _tag: "ThreadViewSnapshot", snapshot: snapshot() })
    const applied = InteractiveController.update(loaded.state, {
      _tag: "ThreadViewPatch",
      patch: patch({
        header: {
          thread: { ...snapshot().thread, title: "Renamed" },
          source: { projectionVersion: 1 },
          pending: [],
          hasOlder: false,
          hasNewer: false,
          usage: snapshot().usage,
        },
      }),
    })
    expect(applied.resync).toBeUndefined()
    expect(applied.state.view?.revision).toBe(5)
    expect(applied.state.model.currentThreadTitle).toBe("Renamed")
  })

  it("projects an exact patch without materializing the full ThreadView", () => {
    const loaded = InteractiveController.update(state(), { _tag: "ThreadViewSnapshot", snapshot: snapshot() }).state
    const view = loaded.view!
    Object.defineProperty(view, "snapshot", {
      value: () => {
        throw new Error("unexpected snapshot materialization")
      },
    })
    const applied = InteractiveController.update(loaded, {
      _tag: "ThreadViewPatch",
      patch: patch({
        header: {
          thread: { ...snapshot().thread, title: "Incremental" },
          source: { projectionVersion: 1 },
          pending: [],
          hasOlder: false,
          hasNewer: false,
          usage: snapshot().usage,
        },
      }),
    })
    expect(applied.resync).toBeUndefined()
    expect(applied.state.model.currentThreadTitle).toBe("Incremental")
    expect(applied.state.view?.revision).toBe(5)
  })

  it("requests resync for gaps, foreign threads, and nonmonotonic revisions", () => {
    const loaded = InteractiveController.update(state(), { _tag: "ThreadViewSnapshot", snapshot: snapshot() }).state
    expect(
      InteractiveController.update(loaded, {
        _tag: "ThreadViewPatch",
        patch: patch({ baseRevision: 3, revision: 5 }),
      }),
    ).toMatchObject({ resync: true, rejection: "revision" })
    expect(
      InteractiveController.update(loaded, {
        _tag: "ThreadViewPatch",
        patch: patch({ threadId: Thread.ThreadId.make("other") }),
      }),
    ).toMatchObject({ resync: true, rejection: "thread" })
    expect(
      InteractiveController.update(loaded, {
        _tag: "ThreadViewPatch",
        patch: patch({ revision: 4 }),
      }),
    ).toMatchObject({ resync: true, rejection: "revision" })
  })

  it("treats cancelling as a distinct active status", () => {
    const value = snapshot()
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...value,
        turns: [
          {
            turn: {
              kind: "agent",
              id: Turn.TurnId.make("turn"),
              threadId: Thread.ThreadId.make("thread"),
              prompt: "prompt",
              status: "cancelling",
              author: { _tag: "Human" },
              lineage: { _tag: "Original" },
              createdAt: 1,
              updatedAt: 2,
            },
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
          },
        ],
      },
    })
    expect(loaded.state.model.busy).toBe(true)
    expect(loaded.state.model.activeTurnId).toBe("turn")
  })

  it("settles a completed patch after reconciling its pending submission", () => {
    const running = {
      kind: "agent" as const,
      id: Turn.TurnId.make("turn"),
      threadId: Thread.ThreadId.make("thread"),
      prompt: "prompt",
      status: "running" as const,
      author: { _tag: "Human" as const },
      lineage: { _tag: "Original" as const },
      createdAt: 1,
      updatedAt: 2,
    }
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [
          {
            turn: running,
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
          },
        ],
      },
    }).state
    const completion = InteractiveController.update(
      {
        ...loaded,
        model: {
          ...loaded.model,
          submittedDrafts: [{ input: "prompt", attachments: [], cursor: 0, turnId: "turn" }],
        },
      },
      {
        _tag: "ThreadViewPatch",
        patch: patch({
          turnChanges: [
            {
              _tag: "UpsertTurn",
              turn: { ...running, status: "completed" },
              projectionRevision: 2,
              usage: ExecutionProjection.emptyUsageState(),
              pendingSteering: [],
              settledSteering: [],
            },
          ],
        }),
      },
    )
    const completed = completion.state.model
    expect(completed.busy).toBe(false)
    expect(completed.activeTurnId).toBeUndefined()
    expect(completed.activity).toBeUndefined()
    expect(completed.submittedDrafts).toEqual([])
    const regressed = InteractiveController.update(completion.state, {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(Thread.ThreadId.make("thread"), 6),
        turns: [
          {
            turn: running,
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
          },
        ],
      },
    })
    expect(regressed.resync).toBeUndefined()
    expect(regressed.state.model.busy).toBe(false)
    const advanced = InteractiveController.update(loaded, {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(Thread.ThreadId.make("thread"), 3),
        turns: [
          {
            turn: { ...running, status: "completed" },
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
          },
        ],
      },
    })
    expect(advanced.resync).toBeUndefined()
    expect(advanced.state.view?.turn("turn")?.turn.status).toBe("completed")
    expect(advanced.state.view?.activeTurn()).toBeUndefined()
    expect(advanced.state.model.activeTurnId).toBeUndefined()
    expect(advanced.state.model.activity).toBeUndefined()
    expect(advanced.state.model.busy).toBe(false)
    const removed = InteractiveController.update(loaded, {
      _tag: "ThreadViewSnapshot",
      snapshot: snapshot(Thread.ThreadId.make("thread"), 2),
    })
    expect(removed.resync).toBeUndefined()
    expect(removed.state.model.busy).toBe(false)
  })

  it("restores a draft when a cancelled snapshot contains only the user prompt", () => {
    const running = {
      kind: "agent" as const,
      id: Turn.TurnId.make("cancelled-turn"),
      threadId: Thread.ThreadId.make("thread"),
      prompt: "cancel this",
      status: "running" as const,
      author: { _tag: "Human" as const },
      lineage: { _tag: "Original" as const },
      createdAt: 1,
      updatedAt: 2,
    }
    const userKey = "cancelled-turn:user"
    const units = [
      {
        key: userKey,
        turnId: running.id,
        order: TranscriptOrdering.unitOrder(userKey, -1),
        revision: 0,
        content: { _tag: "Entry" as const, role: "user" as const, text: running.prompt },
      },
    ]
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [
          {
            turn: running,
            projectionRevision: 0,
            usage: ExecutionProjection.emptyUsageState(),
            units,
          },
        ],
      },
    }).state
    const cancelled = InteractiveController.update(
      {
        ...loaded,
        model: {
          ...loaded.model,
          submittedDrafts: [{ input: running.prompt, attachments: [], cursor: 6, turnId: running.id }],
        },
      },
      {
        _tag: "ThreadViewSnapshot",
        snapshot: {
          ...snapshot(Thread.ThreadId.make("thread"), 5),
          turns: [
            {
              turn: { ...running, status: "cancelled" },
              projectionRevision: 1,
              usage: ExecutionProjection.emptyUsageState(),
              units,
            },
          ],
        },
      },
    ).state.model

    expect(cancelled).toMatchObject({ input: "cancel this", cursor: 6, busy: false })
    expect(cancelled.submittedDrafts).toEqual([])
  })

  it("retains committed output and does not restore the draft when a patch cancels the Turn", () => {
    const running = {
      kind: "agent" as const,
      id: Turn.TurnId.make("responded-turn"),
      threadId: Thread.ThreadId.make("thread"),
      prompt: "start work",
      status: "running" as const,
      author: { _tag: "Human" as const },
      lineage: { _tag: "Original" as const },
      createdAt: 1,
      updatedAt: 2,
    }
    const userKey = "responded-turn:user"
    const assistantKey = "responded-turn:assistant"
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [
          {
            turn: running,
            projectionRevision: 1,
            usage: ExecutionProjection.emptyUsageState(),
            units: [
              {
                key: userKey,
                turnId: running.id,
                order: TranscriptOrdering.unitOrder(userKey, -1),
                revision: 0,
                content: { _tag: "Entry", role: "user", text: running.prompt },
              },
              {
                key: assistantKey,
                turnId: running.id,
                order: TranscriptOrdering.unitOrder(assistantKey, 0),
                revision: 1,
                content: { _tag: "Entry", role: "assistant", text: "committed answer" },
              },
            ],
          },
        ],
      },
    }).state
    const cancelled = InteractiveController.update(
      {
        ...loaded,
        model: {
          ...loaded.model,
          submittedDrafts: [{ input: running.prompt, attachments: [], cursor: 4, turnId: running.id }],
        },
      },
      {
        _tag: "ThreadViewPatch",
        patch: patch({
          turnChanges: [
            {
              _tag: "UpsertTurn",
              turn: { ...running, status: "cancelled" },
              projectionRevision: 2,
              usage: ExecutionProjection.emptyUsageState(),
              pendingSteering: [],
              settledSteering: [],
            },
          ],
        }),
      },
    ).state.model

    expect(cancelled.entries).toContainEqual({
      _tag: "Entry",
      role: "assistant",
      text: "committed answer",
      turnId: running.id,
    })
    expect(cancelled.input).toBe("")
    expect(cancelled.submittedDrafts).toEqual([])
    expect(cancelled.busy).toBe(false)
  })
})
