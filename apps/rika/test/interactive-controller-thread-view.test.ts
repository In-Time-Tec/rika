import { describe, expect, it } from "vitest"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
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

  it("reports a running cell as running work rather than leaving the line at Waiting", () => {
    // A cell is how a turn does work now. Counting only the tool call it replaced left the activity
    // line saying "Waiting" for the whole of a long cell, with nothing telling the reader it is live.
    const source = 'await rika.processes.start({"command":"sleep 10"})'
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
                key: "turn:cell",
                turnId: "turn",
                order: TranscriptOrdering.unitOrder("turn:cell", 1),
                revision: 1,
                content: {
                  _tag: "Block",
                  block: {
                    _tag: "Cell",
                    id: "cell",
                    status: "running",
                    visual: "ts",
                    summary: source,
                    source: { text: source, lines: 1, truncated: false },
                    output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
                    epoch: 0,
                    notices: [],
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

  it("shows a submission only after authoritative admission and deduplicates the durable turn", () => {
    const initial = state()
    const typed = { ...initial, model: { ...initial.model, input: "hello", cursor: 5 } }
    const submitted = reduceModel(typed.model, { _tag: "Submitted", submissionId: "submission-1" })
    const echo = (model: ViewState.Model) =>
      model.entries.filter((entry) => entry.role === "user" && entry.text === "hello").length
    expect(echo(submitted)).toBe(0)
    expect(submitted.busy).toBe(false)

    const loaded = InteractiveController.update(
      { ...typed, model: submitted },
      { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
    )
    expect(loaded.resync).toBeUndefined()
    expect(echo(loaded.state.model)).toBe(0)

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
      entries: [...submitted.entries, { role: "assistant" as const, text: "previous assistant" }],
      items: [
        ...submitted.items,
        { _tag: "Entry" as const, index: submitted.entries.length, id: "previous-assistant" },
      ],
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

  it("leaves the welcome state only when the accepted submission becomes authoritative", () => {
    const welcome = (model: ViewState.Model) => model.entries.length === 0 && model.blocks.length === 0
    const initial = state()
    const typed = { ...initial, model: { ...initial.model, input: "hello", cursor: 5 } }
    const current = {
      ...typed,
      model: reduceModel(typed.model, { _tag: "Submitted", submissionId: "submission-1" }),
    }
    expect(welcome(current.model)).toBe(true)
    expect(current.model.busy).toBe(false)
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
  })
})
