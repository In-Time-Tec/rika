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
  it("reports a running tool as running work rather than leaving the line at Waiting", () => {
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [
          {
            turn: {
              kind: "agent",
              id: Turn.TurnId.make("turn"),
              threadId: Thread.ThreadId.make("thread"),
              prompt: "prompt",
              status: "running",
              author: { _tag: "Human" },
              lineage: { _tag: "Original" },
              createdAt: 1,
              updatedAt: 2,
            },
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [
              {
                key: "turn:tool",
                turnId: "turn",
                order: TranscriptOrdering.unitOrder("turn:tool", 1),
                revision: 1,
                content: {
                  _tag: "Block",
                  block: {
                    _tag: "ToolCall",
                    id: "tool",
                    name: "bash",
                    input: '{"command":"sleep 10"}',
                    status: "running",
                    presentation: {
                      family: "shell",
                      action: "command",
                      activeLabel: "Running",
                      completeLabel: "Ran",
                    },
                    detail: "sleep 10",
                    process: { command: "sleep 10", running: true },
                    files: [],
                  },
                },
              },
            ],
          },
        ],
      },
    })
    expect(loaded.state.model.activity).toEqual({ _tag: "RunningTools", subagents: 0, tools: 1 })
  })

  it("keeps editing a queued turn across snapshot re-projections", () => {
    const pending = [
      { id: Turn.TurnId.make("q1"), prompt: "queued one", createdAt: 1 },
      { id: Turn.TurnId.make("q2"), prompt: "queued two", createdAt: 2 },
    ]
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [],
        pending,
      },
    })
    const model = {
      ...loaded.state.model,
      editingTurnId: "q2",
      editReturn: { input: "", attachments: [] },
      input: "queued two!",
      cursor: 10,
      queueSelection: "q2",
    }
    const projected = InteractiveController.update(
      { ...loaded.state, model },
      { _tag: "ThreadViewPatch", patch: patch() },
    )
    expect(projected.state.model.editingTurnId).toBe("q2")
    expect(projected.state.model.input).toBe("queued two!")
  })

  it("exits edit mode when the edited queued turn leaves the snapshot", () => {
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        turns: [],
        pending: [{ id: Turn.TurnId.make("q1"), prompt: "queued one", createdAt: 1 }],
      },
    })
    const model = {
      ...loaded.state.model,
      editingTurnId: "q1",
      editReturn: { input: "", attachments: [] },
      input: "queued one!",
      cursor: 10,
      queueSelection: "q1",
    }
    const projected = InteractiveController.update(
      { ...loaded.state, model },
      {
        _tag: "ThreadViewPatch",
        patch: patch({
          header: {
            thread: snapshot().thread,
            source: { projectionVersion: 1 },
            pending: [],
            hasOlder: false,
            hasNewer: false,
            usage: snapshot().usage,
          },
        }),
      },
    )
    expect(projected.state.model.editingTurnId).toBeUndefined()
  })

  it("derives footer cost, tokens, context, and union time only from ThreadView usage", () => {
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        usage: {
          state: {
            costNanoUsd: 375_000_000,
            tokens: {
              total: 42,
              input: { total: 30, cacheRead: 5 },
              output: { total: 12, reasoning: 2 },
              failedProviderTotal: 7,
            },
            pricedAttempts: 2,
            unpricedAttempts: 1,
            countedAttempts: 3,
            uncountedAttempts: 1,
            sourceComplete: false,
            context: { requestOrdinal: 2, purpose: "conversation", inputTokens: 30 },
            contextPending: true,
            active: { _tag: "Available", accumulatedMillis: 900, activeSince: 1_000 },
          },
          contextCapacity: { contextWindow: 100, reserveTokens: 10 },
        },
      },
    })
    expect(loaded.state.model).toMatchObject({
      usageCost: { _tag: "Available", usd: 0.375, unpricedAttempts: 1, includedAttempts: 0 },
      usageTokens: { _tag: "Available", total: 42, uncountedAttempts: 1 },
      usageTime: { _tag: "Available", accumulatedMillis: 900, activeSince: 1_000 },
      contextUsage: { _tag: "Available", inputTokens: 30, inputCacheRead: 5, contextWindow: 100, reserveTokens: 10 },
    })
  })

  it("labels account-backed usage as included instead of unpriced", () => {
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        usage: {
          state: {
            tokens: {
              total: 8,
              input: { total: 6, cacheRead: 2 },
              output: { total: 2, reasoning: 1 },
              failedProviderTotal: 0,
            },
            pricedAttempts: 0,
            unpricedAttempts: 0,
            includedAttempts: 2,
            countedAttempts: 2,
            uncountedAttempts: 0,
            sourceComplete: true,
            context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 6 },
            contextPending: false,
            active: { _tag: "Available", accumulatedMillis: 10 },
          },
          contextCapacity: { contextWindow: 100, reserveTokens: 10 },
        },
      },
    })
    expect(loaded.state.model).toMatchObject({
      usageCost: { _tag: "Included", includedAttempts: 2 },
      usageTokens: { _tag: "Available", total: 8, uncountedAttempts: 0 },
    })
  })

  it("shows a submitted prompt immediately and deduplicates the durable turn", () => {
    const initial = state()
    const typed = { ...initial, model: { ...initial.model, input: "hello", cursor: 5 } }
    const submitted = reduceModel(typed.model, { _tag: "Submitted", submissionId: "submission-1" })
    const echo = (model: ViewState.Model) =>
      model.entries.filter((entry) => entry.role === "user" && entry.text === "hello").length
    expect(echo(submitted)).toBe(1)
    expect(submitted.busy).toBe(true)

    const loaded = InteractiveController.update(
      { ...typed, model: submitted },
      { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
    )
    expect(loaded.resync).toBeUndefined()
    expect(echo(loaded.state.model)).toBe(1)
    expect(loaded.state.model.busy).toBe(true)

    const admitted = reduceModel(loaded.state.model, {
      _tag: "SubmissionAdmitted",
      turnId: "turn",
      status: "active",
      submissionId: "submission-1",
    })
    expect(echo(admitted)).toBe(1)
    expect(admitted.busy).toBe(true)

    const headerOnly = InteractiveController.update(
      { ...loaded.state, model: admitted },
      {
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
      },
    )
    expect(headerOnly.resync).toBeUndefined()
    expect(echo(headerOnly.state.model)).toBe(1)

    const started = reduceModel(headerOnly.state.model, {
      _tag: "TurnStarted",
      turnId: "turn",
      prompt: "hello",
      submissionId: "submission-1",
    })
    expect(echo(started)).toBe(1)
  })

  it("keeps an admitted queued submission only in the queue across a header reprojection until start", () => {
    const base = state()
    const busy = { ...base.model, busy: true, activeTurnId: "active", input: "follow up", cursor: 9 }
    const submitted = reduceModel(busy, { _tag: "Submitted", submissionId: "submission-q" })
    const admitted = reduceModel(submitted, {
      _tag: "SubmissionAdmitted",
      turnId: "queued-turn",
      status: "queued",
      submissionId: "submission-q",
    })
    const loaded = InteractiveController.update(
      { ...base, model: admitted },
      {
        _tag: "ThreadViewSnapshot",
        snapshot: {
          ...snapshot(),
          pending: [{ id: Turn.TurnId.make("queued-turn"), prompt: "follow up", createdAt: 2 }],
        },
      },
    )
    const projected = InteractiveController.update(loaded.state, {
      _tag: "ThreadViewPatch",
      patch: patch({
        header: {
          thread: { ...snapshot().thread, title: "Renamed" },
          source: { projectionVersion: 1 },
          pending: [{ id: Turn.TurnId.make("queued-turn"), prompt: "follow up", createdAt: 2 }],
          hasOlder: false,
          hasNewer: false,
          usage: snapshot().usage,
        },
      }),
    }).state.model
    expect(projected.queue.filter((item) => item.prompt === "follow up")).toHaveLength(1)
    expect(projected.entries.filter((entry) => entry.role === "user" && entry.text === "follow up")).toHaveLength(0)

    const started = reduceModel(projected, {
      _tag: "TurnStarted",
      turnId: "queued-turn",
      prompt: "follow up",
      submissionId: "submission-q",
    })
    expect(started.entries.filter((entry) => entry.role === "user" && entry.text === "follow up")).toHaveLength(1)
  })

  it("does not carry transcript or optimistic state into an activated new thread", () => {
    const previousThreadId = Thread.ThreadId.make("previous-thread")
    const newThreadId = Thread.ThreadId.make("new-thread")
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: snapshot(previousThreadId),
    }).state
    const submitted = reduceModel(
      { ...loaded.model, input: "previous thread prompt", cursor: 22 },
      { _tag: "Submitted", submissionId: "previous-submission" },
    )
    const previousTranscript = {
      ...submitted,
      entries: [{ role: "assistant" as const, text: "previous assistant" }],
      items: [{ _tag: "Entry" as const, index: 0, id: "previous-assistant" }],
      steeringRequests: [
        { requestId: "previous-steering", turnId: "previous-turn", text: "redirect", origin: "composer" as const },
      ],
      busy: false,
      activity: undefined,
    }
    expect(previousTranscript.entries.map((entry) => entry.text)).toEqual(["previous assistant"])
    const activated = reduceModel(previousTranscript, {
      _tag: "ThreadActivated",
      threadId: newThreadId,
      title: "New thread",
    })
    const createdSnapshot = snapshot(newThreadId, 0)
    const created = InteractiveController.update(
      { ...loaded, model: activated },
      {
        _tag: "ThreadViewSnapshot",
        snapshot: {
          ...createdSnapshot,
          thread: { ...createdSnapshot.thread, title: "New thread" },
        },
      },
    ).state.model

    expect(created).toMatchObject({
      currentThreadId: "new-thread",
      currentThreadTitle: "New thread",
      entries: [],
      blocks: [],
      items: [],
      queue: [],
      submittedDrafts: [],
      steeringRequests: [],
      busy: false,
    })
    expect(created.activeTurnId).toBeUndefined()
    expect(created.activity).toBeUndefined()
  })
})
