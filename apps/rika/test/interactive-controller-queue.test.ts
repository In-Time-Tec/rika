import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ThreadSelection from "../src/interactive/controller/terminal-thread-selection"
import * as InteractiveFrameBatch from "../src/interactive/controller/interactive-frame-batch"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as Reducer from "@rika/terminal/terminal-state-reducer"
import { expect, it } from "vitest"
import {
  thread,
  entries,
  cursor,
  initialState,
  visibleState,
  unitDelta,
} from "./interactive-controller-transcript-fixtures"
import { projectionOrigin, startProjection, makeProjectionFeed } from "./interactive-controller-stream-fixtures"
import { runningTurn } from "./interactive-controller-active-fixtures"

it("clears working state when the semantic event stream reaches a terminal event", () => {
  const persisted = entries("new", 2)
  const activeTurn = { ...persisted[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn,
  })
  const feed = makeProjectionFeed(
    page.state,
    activeTurn,
    TranscriptProjection.Projection.empty(activeTurn.id, activeTurn.prompt),
  )
  feed.apply({ cursor: "completed", sequence: 1, type: "execution.completed", createdAt: 3 })
  const completed = feed.stop("completed")

  expect(completed.state.model).toMatchObject({ busy: false, activity: undefined, activeTurnId: undefined })
})

it("keeps the newest logical selection when delayed A to B to A work arrives", () => {
  const threadB = { ...thread, id: Thread.ThreadId.make("thread-b"), title: "Thread B" }
  const load = (
    state: InteractiveController.State,
    selected: Thread.Thread,
    selectionEpoch: number,
    values: ReturnType<typeof entries>,
  ) =>
    InteractiveController.update(state, {
      _tag: "SelectionLoaded",
      selectionEpoch,
      activitySequence: selectionEpoch,
      thread: selected,
      entries: values,
      hasOlder: false,
      threadCostUsd: 0,
      queueRevision: selectionEpoch,
      queue: [],
    })
  const a1 = load(initialState(), thread, 1, entries("a-1", 1))
  const b2 = load(a1.state, threadB, 2, [])
  const a3 = load(b2.state, thread, 3, entries("a-3", 3))
  const delayedA1 = load(a3.state, thread, 1, entries("stale-a", 4))
  const staleTurn = entries("a-1", 1)[0]!.turn
  const staleProjection = TranscriptProjection.Projection.project(staleTurn.id, staleTurn.prompt, [
    {
      cursor: "stale",
      sequence: 9,
      type: "model.output.completed",
      createdAt: 9,
      text: "stale",
    },
  ])
  const delayedPatch = InteractiveController.update(delayedA1.state, {
    _tag: "TranscriptProjectionStarted",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: staleTurn.id,
    turn: staleTurn,
    streamId: "stream:a-1",
    patchRevision: 0,
    state: visibleState(staleProjection),
    units: staleProjection.units,
  })

  expect(delayedA1.state).toBe(a3.state)
  expect(delayedPatch.state).toBe(a3.state)
  expect(delayedPatch.state.selectionEpoch).toBe(3)
  expect(delayedPatch.state.model).toMatchObject({ currentThreadId: "thread-a", currentThreadTitle: "Thread A" })
  expect(delayedPatch.state.model.entries.map((entry) => entry.text)).toEqual(["a-3"])
})

it("requests a queue resync when the durable count disagrees with an otherwise contiguous delta", () => {
  const model = {
    ...initialState().model,
    currentThreadId: "thread-a",
    queueThreadId: "thread-a",
    queueRevision: 1,
  }
  const updated = ThreadSelection.updateQueue(model, {
    _tag: "QueueUpdated",
    selectionEpoch: 1,
    threadId: Thread.ThreadId.make("thread-a"),
    revision: 2,
    queuedCount: 2,
    change: { _tag: "Added", item: { id: Turn.TurnId.make("queued"), prompt: "queued" } },
  })

  expect(updated.model.queue).toEqual([{ id: "queued", prompt: "queued" }])
  expect(updated.resync).toBe(true)
})

it("restores the rejected composer and reports the pending count when the queue is full", () => {
  const submitted = Reducer.update(
    Reducer.update(initialState().model, { _tag: "ComposerReplaced", text: "retry this prompt" }),
    { _tag: "Submitted" },
  )
  const updated = ThreadSelection.updateQueue(submitted, {
    _tag: "QueueFull",
    selectionEpoch: 0,
    threadId: Thread.ThreadId.make("thread-a"),
    capacity: 2,
    count: 2,
  })

  expect(updated.model.input).toBe("retry this prompt")
  expect(updated.model.blocks.at(-1)).toMatchObject({
    _tag: "Error",
    detail: "Queue full: 2 pending prompts",
  })
})

it("removes a promoted turn and exits queue edit mode synchronously", () => {
  const queued = Reducer.resetQueue(
    {
      ...initialState().model,
      currentThreadId: "thread-a",
      editingTurnId: "promoted",
      editReturn: { input: "keep this draft", attachments: [] },
      input: "edited queued prompt",
      cursor: 20,
    },
    "thread-a",
    4,
    [{ id: "promoted", prompt: "edited queued prompt" }],
  )

  const promoted = ThreadSelection.removePromotedTurn(queued, "thread-a", "promoted")

  expect(promoted.queue).toEqual([])
  expect(promoted.queueRevision).toBe(5)
  expect(promoted.editingTurnId).toBeUndefined()
  expect(promoted.input).toBe("keep this draft")
})

it("eagerly consumes more than one frame of events while bounding reducer work per render frame", () => {
  type ProjectionPatched = Extract<InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>
  const scheduled: Array<() => void> = []
  let received = 0
  let applied = 0
  let renders = 0
  const persisted = entries("stream", 2)
  const turn = { ...persisted[0]!.turn, status: "running" as const }
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  }).state
  let projection = TranscriptProjection.Projection.empty(turn.id, turn.prompt)
  state = startProjection(state, turn, projection).state
  const events: ReadonlyArray<ProjectionPatched> = Array.from({ length: 257 }, (_, index) => {
    const source: TranscriptSourceEvent.SourceEvent = {
      cursor: `chunk-${index}`,
      sequence: index,
      type: "model.output.delta",
      createdAt: index,
      text: index === 256 ? "FINAL-CHUNK" : "x",
    }
    const next = TranscriptProjection.Projection.applyEvent(projection, source)
    const event: ProjectionPatched = {
      _tag: "TranscriptProjectionPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      rootTurnId: turn.id,
      streamId: `stream:${turn.id}`,
      baseRevision: index,
      patchRevision: index + 1,
      origin: projectionOrigin(source, `execution:${turn.id}`),
      state: visibleState(next),
      delta: unitDelta(projection, next),
    }
    projection = next
    return event
  })
  const batcher = InteractiveFrameBatch.makeFeedFrameBatcher<ProjectionPatched>({
    schedule: (flush) => scheduled.push(flush),
    apply: (batch) => {
      for (const event of batch) {
        state = InteractiveController.update(state, event).state
        applied += 1
      }
    },
    render: () => {
      renders += 1
    },
  })
  const consume = (dispatch: (event: ProjectionPatched) => void) => {
    for (const event of events) {
      received += 1
      dispatch(event)
    }
  }

  consume(batcher.offer)

  expect(received).toBe(257)
  expect(applied).toBe(0)
  expect(scheduled).toHaveLength(1)
  scheduled.shift()?.()
  expect(applied).toBe(256)
  expect(scheduled).toHaveLength(1)
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied).toBe(257)
  expect(renders).toBe(2)
  expect(state.model.entries.some((entry) => entry.text.includes("FINAL-CHUNK"))).toBe(true)

  batcher.offer(events[0]!)
  expect(scheduled).toHaveLength(1)
})

it("preserves feed order across lanes and batch boundaries", () => {
  type FeedEvent = {
    readonly id: string
    readonly lane: "root" | "child"
  }
  const scheduled: Array<() => void> = []
  const applied: Array<string> = []
  const batcher = InteractiveFrameBatch.makeFeedFrameBatcher<FeedEvent>({
    schedule: (flush) => scheduled.push(flush),
    apply: (events) => applied.push(...events.map((event) => event.id)),
    render: () => undefined,
  })
  for (let index = 0; index < 300; index += 1) batcher.offer({ id: `child-${index}`, lane: "child" })
  batcher.offer({ id: "root-progress", lane: "root" })
  batcher.offer({ id: "root-result", lane: "root" })

  scheduled.shift()?.()

  expect(applied).toHaveLength(256)
  expect(applied).toEqual(Array.from({ length: 256 }, (_, index) => `child-${index}`))
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied).toEqual([
    ...Array.from({ length: 300 }, (_, index) => `child-${index}`),
    "root-progress",
    "root-result",
  ])
})

it("keeps bidirectional transcript navigation within the semantic window budget", () => {
  const pageEntries = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => entries(`window-${from + index}`, from + index)[0]!)
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries(200, 200),
    hasOlder: true,
  }).state
  for (let page = 0; page < 6; page++)
    state = InteractiveController.update(state, {
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId: thread.id,
      entries: pageEntries(150 - page * 50, 50),
      hasOlder: page < 5,
    }).state

  expect(state.entries.length).toBeLessThanOrEqual(InteractiveController.transcriptWindowEntryBudget)
  expect(new Set(state.entries.map((entry) => entry.unit.key)).size).toBe(state.entries.length)
  expect(state.entries[0]!.turn.createdAt).toBeLessThan(200)
  expect(state.hasNewer).toBe(true)

  for (let page = 0; page < 6; page++)
    state = InteractiveController.update(state, {
      _tag: "TranscriptPageAppended",
      selectionEpoch: 1,
      threadId: thread.id,
      entries: pageEntries(200 + page * 50, 50),
      hasNewer: page < 5,
      requestedAfter: cursor(state.entries.at(-1)!),
    }).state

  expect(state.entries.length).toBeLessThanOrEqual(InteractiveController.transcriptWindowEntryBudget)
  expect(new Set(state.entries.map((entry) => entry.unit.key)).size).toBe(state.entries.length)
  expect(state.entries.map((entry) => entry.turn.createdAt)).toEqual(
    state.entries.map((entry) => entry.turn.createdAt).toSorted((left, right) => left - right),
  )
  expect(state.entries.at(-1)!.turn.createdAt).toBeGreaterThanOrEqual(450)
  expect(state.hasNewer).toBe(false)
  expect(state.hasOlder).toBe(true)
  const stale = InteractiveController.update(state, {
    _tag: "TranscriptPageAppended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: pageEntries(900, 10),
    hasNewer: false,
    requestedAfter: cursor(state.entries[0]!),
  })
  expect(stale.state).toBe(state)
})

it("keeps the active projection outside the bounded contiguous history window", () => {
  const active = runningTurn("active-window")
  const pageEntries = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => entries(`active-history-${from + index}`, from + index)[0]!)
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries(200, 200),
    hasOlder: true,
    activeTurn: active,
  }).state
  for (let page = 0; page < 6; page += 1)
    state = InteractiveController.update(state, {
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId: thread.id,
      entries: pageEntries(150 - page * 50, 50),
      hasOlder: page < 5,
    }).state

  expect(state.entries).toHaveLength(InteractiveController.transcriptWindowEntryBudget)
  expect(state.entries.some((entry) => entry.turn.id === active.id)).toBe(false)
  expect(state.model.entries.map((entry) => entry.text)).toContain(active.prompt)
  expect(state.newestCursor?.turnId).not.toBe(active.id)
})
