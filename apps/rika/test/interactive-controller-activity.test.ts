import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as InteractiveFrameBatch from "../src/interactive/controller/interactive-frame-batch"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as ViewState from "@rika/terminal/terminal-state"
import * as Reducer from "@rika/terminal/terminal-state-reducer"
import * as Message from "@rika/terminal/terminal-message"
import { expect, it } from "vitest"
import { thread, entries, initialState, visibleState, unitDelta } from "./interactive-controller-transcript-fixtures"
import { projectionOrigin, startProjection, makeProjectionFeed } from "./interactive-controller-stream-fixtures"

it("keeps one of five status labels from submit until the turn completes", () => {
  const turn = { ...entries("active", 2)[0]!.turn, status: "running" as const }
  const submitted = Reducer.update(
    { ...ViewState.initial("/work", "medium"), input: "run it", cursor: 6 },
    { _tag: "Submitted" },
  )
  let state: InteractiveController.State = {
    ...initialState(),
    selectionEpoch: 1,
    model: { ...submitted, currentThreadId: thread.id, activeTurnId: turn.id },
    replayTurns: new Map([[turn.id, turn]]),
    entries: entries(turn.id, turn.createdAt),
  }
  const feed = makeProjectionFeed(state, turn, TranscriptProjection.Projection.empty(turn.id, turn.prompt))
  state = feed.state
  const labels = ["Sending", "Waiting", "Thinking 2 tok", "Streaming 2 tok", "Running 1 tool", "Running 2 tools"]
  const expectStatus = (expected: string) => {
    const label = Message.formatActivity(state.model.activity)
    expect(label).toBe(expected)
    expect(labels).toContain(label)
  }
  const patch = (sequence: number, type: string, text?: string, data?: Readonly<Record<string, unknown>>) => {
    state = feed.apply({
      cursor: `event-${sequence}`,
      sequence,
      type,
      createdAt: sequence,
      ...(text === undefined ? {} : { text }),
      ...(data === undefined ? {} : { data }),
    }).state
  }

  expectStatus("Sending")
  patch(0, "execution.accepted")
  expectStatus("Waiting")
  patch(1, "execution.started")
  expectStatus("Waiting")
  patch(2, "model.input.prepared")
  expectStatus("Waiting")
  patch(3, "model.reasoning.delta", "12345678")
  expectStatus("Thinking 2 tok")
  patch(4, "tool.call.requested", undefined, {
    tool_call_id: "read",
    tool_name: "read",
    input: { path: "src/a.ts" },
  })
  expectStatus("Running 1 tool")
  patch(5, "tool.call.requested", undefined, {
    tool_call_id: "status",
    tool_name: "bash",
    input: { command: "git --no-optional-locks status --short --branch" },
  })
  expectStatus("Running 2 tools")
  patch(6, "tool.result.received", undefined, { tool_call_id: "read", output: "contents" })
  expectStatus("Running 1 tool")
  patch(7, "tool.result.received", undefined, { tool_call_id: "status", output: "clean" })
  expectStatus("Waiting")
  patch(8, "model.output.delta", "abcdefgh")
  expectStatus("Streaming 2 tok")
  patch(9, "model.output.completed", "abcdefgh")
  expectStatus("Waiting")
  patch(10, "execution.completed")
  expectStatus("Waiting")
  expect(state.model.busy).toBe(true)
  state = feed.stop("completed").state
  expect(Message.formatActivity(state.model.activity)).toBeUndefined()
  expect(state.model.busy).toBe(false)
})

it("keeps 200ms tool lifecycle events in distinct TUI frames", () => {
  type ProjectionPatchedEvent = Extract<InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>
  type ProjectionPatched = ProjectionPatchedEvent & {
    readonly origin: Extract<ProjectionPatchedEvent["origin"], { readonly _tag: "Event" }>
  }
  const turn = { ...entries("timed", 2)[0]!.turn, status: "running" as const }
  let state: InteractiveController.State = {
    ...initialState(),
    selectionEpoch: 1,
    model: {
      ...initialState().model,
      currentThreadId: thread.id,
      activeTurnId: turn.id,
      busy: true,
      activity: { _tag: "Waiting" },
    },
    replayTurns: new Map([[turn.id, turn]]),
    entries: entries(turn.id, turn.createdAt),
  }
  state = startProjection(state, turn, TranscriptProjection.Projection.empty(turn.id, turn.prompt)).state
  let now = 0
  const scheduled: Array<{ readonly at: number; readonly flush: () => void }> = []
  const applied: Array<{ readonly at: number; readonly type: string; readonly activity: string | undefined }> = []
  const batcher = InteractiveFrameBatch.makeFeedFrameBatcher<ProjectionPatched>({
    schedule: (flush) => scheduled.push({ at: now + 16, flush }),
    apply: (events) => {
      for (const event of events) {
        state = InteractiveController.update(state, event).state
        applied.push({ at: now, type: event.origin.type, activity: Message.formatActivity(state.model.activity) })
      }
    },
    render: () => {},
  })
  const advance = (target: number) => {
    while (scheduled[0] !== undefined && scheduled[0].at <= target) {
      const next = scheduled.shift()!
      now = next.at
      next.flush()
    }
    now = target
  }
  let projection = TranscriptProjection.Projection.empty(turn.id, turn.prompt)
  let patchRevision = 0
  const event = (
    sequence: number,
    type: "tool.call.requested" | "tool.result.received",
    callId: string,
  ): ProjectionPatched => {
    const source: TranscriptSourceEvent.SourceEvent = {
      cursor: `timed-${sequence}`,
      sequence,
      type,
      createdAt: now,
      data:
        type === "tool.call.requested"
          ? { tool_call_id: callId, tool_name: "read", input: { path: `${callId}.ts` } }
          : { tool_call_id: callId, output: callId },
    }
    const next = TranscriptProjection.Projection.applyEvent(projection, source)
    const baseRevision = patchRevision
    patchRevision += 1
    const patched: ProjectionPatched = {
      _tag: "TranscriptProjectionPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      rootTurnId: turn.id,
      streamId: `stream:${turn.id}`,
      baseRevision,
      patchRevision,
      origin: projectionOrigin(source, `execution:${turn.id}`),
      state: visibleState(next),
      delta: unitDelta(projection, next),
    }
    projection = next
    return patched
  }

  batcher.offer(event(0, "tool.call.requested", "first"))
  batcher.offer(event(1, "tool.call.requested", "second"))
  advance(200)
  batcher.offer(event(2, "tool.result.received", "first"))
  advance(400)
  batcher.offer(event(3, "tool.result.received", "second"))
  advance(500)

  expect(applied.map(({ at }) => at)).toEqual([16, 16, 216, 416])
  expect(applied.map(({ activity }) => activity)).toEqual([
    "Running 1 tool",
    "Running 2 tools",
    "Running 1 tool",
    "Waiting",
  ])
})

it("keeps the authoritative thread cost stable while older pages are prepended", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 3.75,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 3.75,
  })

  expect(page.state.model.costUsd).toBe(3.75)
  expect(prepended.state.model.costUsd).toBe(3.75)
})

it("projects selected-thread active time and ignores stale selection updates", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
  })
  const active = InteractiveController.update(page.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Available", accumulatedMillis: 5_000, activeSince: 10_000 },
  })
  const stale = InteractiveController.update(active.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 0,
    threadId: thread.id,
    revision: 2,
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Available", accumulatedMillis: 99_000 },
  })

  expect(active.state.model.usageTime).toEqual({
    _tag: "Available",
    accumulatedMillis: 5_000,
    activeSince: 10_000,
  })
  expect(stale.state.model.usageTime).toBe(active.state.model.usageTime)
})

it("keeps the newest committed usage revision and drops older ones", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
  })
  const usage = (revision: number, usd: number, accumulatedMillis: number) =>
    ({
      _tag: "ThreadUsageUpdated",
      selectionEpoch: 1,
      threadId: thread.id,
      revision,
      cost: { _tag: "Available", usd, unpricedAttempts: 0 },
      tokens: { _tag: "Unavailable" },
      time: { _tag: "Available", accumulatedMillis },
    }) as const
  const committed = InteractiveController.update(page.state, usage(7, 100.0014, 30_000))
  const late = InteractiveController.update(committed.state, usage(6, 150, 0))
  const newer = InteractiveController.update(late.state, usage(8, 100.5, 31_000))

  expect(committed.state.model.usageCost).toEqual({ _tag: "Available", usd: 100.0014, unpricedAttempts: 0 })
  expect(late.state.model.usageCost).toBe(committed.state.model.usageCost)
  expect(late.state.model.usageTime).toBe(committed.state.model.usageTime)
  expect(newer.state.model.usageCost).toEqual({ _tag: "Available", usd: 100.5, unpricedAttempts: 0 })
  expect(newer.state.model.usageTime).toEqual({ _tag: "Available", accumulatedMillis: 31_000 })
})

it("preserves available usage across an unpriced refresh without carrying it to a new thread", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
  })
  const available = InteractiveController.update(page.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    cost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0 },
    tokens: { _tag: "Available", total: 10, uncountedAttempts: 0 },
    time: { _tag: "Unavailable" },
  })
  const refreshed = InteractiveController.update(available.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 1,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
  })
  const unpriced = InteractiveController.update(refreshed.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 2,
    threadId: thread.id,
    revision: 2,
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Unavailable" },
  })
  const otherThread = { ...thread, id: Thread.ThreadId.make("other-thread") }
  const newSelection = InteractiveController.update(unpriced.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 3,
    activitySequence: 2,
    queueRevision: 0,
    queue: [],
    thread: otherThread,
    entries: entries("other", 2),
    hasOlder: false,
  })
  const unknown = InteractiveController.update(newSelection.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 3,
    threadId: otherThread.id,
    revision: 1,
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Unavailable" },
  })

  expect(unpriced.state.model.usageCost).toEqual({ _tag: "Available", usd: 1.25, unpricedAttempts: 0 })
  expect(unpriced.state.model.costUsd).toBe(1.25)
  expect(unknown.state.model.usageCost).toEqual({ _tag: "Unavailable" })
  expect(unknown.state.model.costUsd).toBeUndefined()
})

it("shows the session total and updates it when child usage arrives", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2, [
      {
        cursor: "parent-usage",
        sequence: 0,
        type: "model.usage.reported",
        createdAt: 2,
        data: { cost_usd: 0.5 },
      },
    ]),
    hasOlder: false,
    threadCostUsd: 0.5,
    globalCostUsd: 10,
  })
  const child = InteractiveController.update(page.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    cost: { _tag: "Available", usd: 0.75, unpricedAttempts: 0 },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Unavailable" },
  })

  expect(page.state.model.costUsd).toBe(0.5)
  expect(child.state.model.costUsd).toBe(0.75)
  expect(child.state.threadCostUsd).toBe(0.75)
})

it("applies a usage aggregate without lowering the semantic projection revision", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2),
    hasOlder: false,
    threadCostUsd: 0.5,
  })
  const current = { ...page.state, revisions: new Map([["parent", 9]]) }
  const late = InteractiveController.update(current, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    cost: { _tag: "Available", usd: 0.75, unpricedAttempts: 0 },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Unavailable" },
  })

  expect(late.state.model.costUsd).toBe(0.75)
  expect(late.state.threadCostUsd).toBe(0.75)
  expect(late.state.revisions.get("parent")).toBe(9)
})
