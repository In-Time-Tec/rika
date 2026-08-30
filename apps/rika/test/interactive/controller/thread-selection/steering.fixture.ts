import * as InteractiveController from "../../../../src/interactive/controller/service"
import { describe, expect, it } from "vitest"
import * as ViewState from "@rika/terminal/terminal-state"
import { update as reduceModel } from "@rika/terminal/terminal-state-reducer"
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
  it("reconciles duplicate steering text by request identity at consumption and discard", () => {
    const turn = {
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
    const initial = state()
    const requested = {
      ...initial,
      model: {
        ...initial.model,
        activeTurnId: "turn",
        busy: true,
        steeringRequests: [
          { requestId: "request-a", turnId: "turn", text: "same text", origin: "composer" as const },
          {
            requestId: "request-b",
            turnId: "turn",
            text: "same text",
            origin: "queue" as const,
            queuedTurnId: "queued-turn",
          },
        ],
      },
    }
    const accepted = InteractiveController.update(requested, {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [
          {
            turn,
            projectionRevision: 1,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
            pendingSteering: [
              { runId: "run", entryId: "entry-a", requestId: "request-a", sequence: 1, text: "same text" },
            ],
          },
        ],
      },
    })
    expect(accepted.state.model.pendingSteering.map((row) => row.requestId)).toEqual(["request-a"])
    expect(accepted.state.model.steeringRequests.map((row) => row.requestId)).toEqual(["request-b"])

    const consumedKey = ExecutionProjection.steeringUnitKey("turn", "run", "request-a", "entry-a", 1)
    const consumed = InteractiveController.update(accepted.state, {
      _tag: "ThreadViewPatch",
      patch: patch({
        upsert: [
          {
            key: consumedKey,
            turnId: "turn",
            order: TranscriptOrdering.unitOrder(consumedKey, 2),
            revision: 1,
            content: { _tag: "Entry", role: "user", text: "same text" },
          },
        ],
        turnChanges: [
          {
            _tag: "UpsertTurn",
            turn,
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            pendingSteering: [
              { runId: "run", entryId: "entry-b", requestId: "request-b", sequence: 2, text: "same text" },
            ],
          },
        ],
      }),
    })
    expect(consumed.state.model.pendingSteering.map((row) => row.requestId)).toEqual(["request-b"])
    expect(consumed.state.model.steeringRequests).toEqual([])
    expect(
      consumed.state.model.entries.filter((entry) => entry.role === "user" && entry.text === "same text"),
    ).toHaveLength(1)
    expect(consumed.state.model.busy).toBe(true)

    const discarded = InteractiveController.update(consumed.state, {
      _tag: "ThreadViewPatch",
      patch: patch({
        baseRevision: 5,
        revision: 6,
        turnChanges: [
          {
            _tag: "UpsertTurn",
            turn,
            projectionRevision: 3,
            usage: ExecutionProjection.emptyUsageState(),
            pendingSteering: [],
          },
        ],
      }),
    })
    expect(discarded.state.model.pendingSteering).toEqual([])
    expect(
      discarded.state.model.entries.filter((entry) => entry.role === "user" && entry.text === "same text"),
    ).toHaveLength(1)

    const reconnected = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: { ...discarded.state.view!.snapshot(), revision: 7 },
    })
    expect(reconnected.state.model.pendingSteering).toEqual([])
    expect(
      reconnected.state.model.entries.filter((entry) => entry.role === "user" && entry.text === "same text"),
    ).toHaveLength(1)
  })

  it("does not clear local steering from terminal status without an exact disposition", () => {
    const turn = {
      kind: "agent" as const,
      id: Turn.TurnId.make("terminal-turn"),
      threadId: Thread.ThreadId.make("thread"),
      prompt: "prompt",
      status: "completed" as const,
      author: { _tag: "Human" as const },
      lineage: { _tag: "Original" as const },
      createdAt: 1,
      updatedAt: 2,
    }
    const initial = state()
    const requested = {
      ...initial,
      model: {
        ...initial.model,
        steeringRequests: [
          { requestId: "terminal-request", turnId: "terminal-turn", text: "redirect", origin: "composer" as const },
        ],
      },
    }
    const terminal = InteractiveController.update(requested, {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [
          {
            turn,
            projectionRevision: 1,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
          },
        ],
      },
    })
    expect(terminal.state.model.steeringRequests).toHaveLength(1)

    const disposed = InteractiveController.update(terminal.state, {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(Thread.ThreadId.make("thread"), 5),
        turns: [
          {
            turn,
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
            settledSteering: [
              {
                runId: "terminal-run",
                entryId: "terminal-entry",
                requestId: "terminal-request",
                sequence: 3,
                outcome: "discarded",
              },
            ],
          },
        ],
      },
    })
    expect(disposed.state.model.steeringRequests).toEqual([])
  })

  it("leaves the welcome state on submit and does not duplicate the accepted turn snapshot", () => {
    const welcome = (model: ViewState.Model) => model.entries.length === 0 && model.blocks.length === 0
    const initial = state()
    const typed = { ...initial, model: { ...initial.model, input: "hello", cursor: 5 } }
    const current = {
      ...typed,
      model: reduceModel(typed.model, { _tag: "Submitted", submissionId: "submission-1" }),
    }
    expect(welcome(current.model)).toBe(false)
    expect(current.model.busy).toBe(true)
    const loaded = InteractiveController.update(current, {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        revision: 0,
        turns: [
          {
            turn: {
              kind: "agent",
              id: Turn.TurnId.make("turn"),
              threadId: Thread.ThreadId.make("thread"),
              prompt: "hello",
              status: "accepted",
              author: { _tag: "Human" },
              lineage: { _tag: "Original" },
              createdAt: 1,
              updatedAt: 1,
            },
            projectionRevision: 0,
            usage: ExecutionProjection.emptyUsageState(),
            units: [
              {
                key: "turn:turn:user",
                turnId: "turn",
                order: [{ sequence: -1, part: 0, key: "turn:turn:user" }],
                revision: 0,
                content: { _tag: "Entry", role: "user", text: "hello" },
              },
            ],
          },
        ],
      },
    })
    expect(welcome(loaded.state.model)).toBe(false)
    expect(loaded.state.model.busy).toBe(true)
    expect(loaded.state.model.activeTurnId).toBe("turn")
    expect(loaded.state.model.entries.filter((entry) => entry.role === "user" && entry.text === "hello")).toHaveLength(
      1,
    )
  })
})
