import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { expect, it } from "vitest"
import { thread, entries, asRunningEntry, cursor, initialState } from "./interactive-controller-transcript-fixtures"
import { makeProjectionFeed } from "./interactive-controller-stream-fixtures"
import { runningTurn, orphanEntries, populatedSelection } from "./interactive-controller-active-fixtures"

it("keeps a populated view when a reload delivers a window that renders nothing", () => {
  const active = runningTurn("active")
  const populated = populatedSelection(active)
  const reloaded = InteractiveController.update(populated.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: orphanEntries(active, 5),
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })

  expect(populated.state.model.entries.map((value) => value.text)).toContain("history answer")
  expect(reloaded.discarded).toBe(true)
  expect(reloaded.state.model.entries.map((value) => value.text)).toContain("history answer")
  expect(reloaded.state.selectionEpoch).toBe(2)
})

it("accepts an authoritative empty same-thread replacement", () => {
  const populated = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("removed", 1, [
      { cursor: "removed-answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
    ]),
    hasOlder: false,
  })
  const replaced = InteractiveController.update(populated.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 1,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [],
    hasOlder: false,
  })

  expect(replaced.discarded).toBeUndefined()
  expect(replaced.state.entries).toEqual([])
  expect(replaced.state.model.items).toEqual([])
  expect(replaced.state.replayTurns).toEqual(new Map())
})

it("accepts a newer sole-active full selection", () => {
  const active = runningTurn("sole-active")
  const snapshot = (text: string) =>
    entries(active.id, active.createdAt, [
      { cursor: text, sequence: 1, type: "model.output.completed", createdAt: 3, text },
    ]).map(asRunningEntry)
  const populated = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: snapshot("OLD SNAPSHOT"),
    hasOlder: false,
    activeTurn: active,
  })
  const replaced = InteractiveController.update(populated.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: snapshot("NEW SNAPSHOT"),
    hasOlder: false,
    activeTurn: active,
  })

  expect(replaced.discarded).toBeUndefined()
  expect(replaced.state.model.entries.map((value) => value.text)).toContain("NEW SNAPSHOT")
  expect(replaced.state.model.entries.map((value) => value.text)).not.toContain("OLD SNAPSHOT")
  expect(replaced.state.liveProjections.get(active.id)?.units).toEqual(
    expect.arrayContaining([expect.objectContaining({ content: expect.objectContaining({ text: "NEW SNAPSHOT" }) })]),
  )
})

it("keeps prior turns when a same-thread resync reload contains only the active prompt", () => {
  const active = runningTurn("active-prompt-reload")
  const populated = populatedSelection(active)
  const resync = InteractiveController.update(populated.state, {
    _tag: "TranscriptResyncRequired",
    selectionEpoch: 1,
    threadId: thread.id,
    reason: "bounded feed",
  })
  const activeProjection = TranscriptProjection.Projection.empty(active.id, active.prompt)
  const activeEntries = activeProjection.units.map((unit) => ({
    turn: active,
    unit,
    projectionRevision: activeProjection.revision,
    projectionModelPhase: activeProjection.modelPhase,
  }))
  const reloaded = InteractiveController.update(resync.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 1,
    queueRevision: 0,
    queue: [],
    thread,
    entries: activeEntries,
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })

  expect(populated.state.model.entries.map((value) => value.text)).toContain("history answer")
  expect(reloaded.discarded).toBe(true)
  expect(reloaded.state.model.entries.map((value) => value.text)).toEqual(
    expect.arrayContaining(["history", "history answer", active.prompt]),
  )
  expect(reloaded.state.selectionEpoch).toBe(2)
  expect(reloaded.state.activitySequence).toBe(1)
  expect(reloaded.state.projectionStreams).toEqual(new Map())

  const settled = InteractiveController.update(reloaded.state, {
    _tag: "TurnSettled",
    selectionEpoch: 2,
    activitySequence: 2,
    threadId: thread.id,
    turnId: active.id,
    status: "completed",
  })
  const completedActive = { ...active, status: "completed" as const }
  const completed = InteractiveController.update(settled.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 2,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [
      ...entries("history", 1),
      ...activeEntries.map((entry) => Object.assign({}, entry, { turn: completedActive })),
    ],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(settled.state.model).toMatchObject({ activeTurnId: undefined, busy: false })
  expect(completed.discarded).toBeUndefined()
  expect(completed.state.model.entries.map((value) => value.text)).toEqual(
    expect.arrayContaining(["history", "history answer", active.prompt]),
  )
})

it("rebuilds bounded retained history and cursors before paging into an evicted interval", () => {
  const history = Array.from({ length: 400 }, (_, index) => entries(`bounded-h${index}`, index)[0]!)
  const active = { ...runningTurn("bounded-active"), createdAt: 500, updatedAt: 500 }
  const streamedTurn = { ...runningTurn("streamed"), createdAt: 400, updatedAt: 400 }
  const streamedProjection: TranscriptProjectionModel.Projection = {
    units: Array.from({ length: 100 }, (_, index) => ({
      key: `${streamedTurn.id}:unit:${index}`,
      turnId: streamedTurn.id,
      order: TranscriptOrdering.unitOrder(`${streamedTurn.id}:unit:${index}`, index),
      revision: index,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: `streamed ${index}` },
    })),
    revision: 100,
    modelPhase: 0,
  }
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: history,
    hasOlder: true,
    activeTurn: active,
  })
  const replayTurns = new Map(selected.state.replayTurns)
  replayTurns.set(streamedTurn.id, streamedTurn)
  const liveProjections = new Map(selected.state.liveProjections)
  liveProjections.set(streamedTurn.id, streamedProjection)
  const reloaded = InteractiveController.update(
    { ...selected.state, replayTurns, liveProjections },
    {
      _tag: "SelectionLoaded",
      selectionEpoch: 2,
      activitySequence: 1,
      queueRevision: 0,
      queue: [],
      thread,
      entries: entries(active.id, active.createdAt).map(asRunningEntry),
      hasOlder: true,
      activeTurn: active,
    },
  )

  expect(reloaded.discarded).toBe(true)
  expect(reloaded.state.entries).toHaveLength(InteractiveController.transcriptWindowEntryBudget)
  expect(reloaded.state.entries[0]?.turn.id).toBe("bounded-h100")
  expect(reloaded.state.entries.at(-1)?.turn.id).toBe(streamedTurn.id)
  expect(reloaded.state.oldestCursor).toEqual(cursor(reloaded.state.entries[0]!))
  expect(reloaded.state.newestCursor).toEqual(cursor(reloaded.state.entries.at(-1)!))
  expect(reloaded.state.hasOlder).toBe(true)
  expect(reloaded.state.model.entries.map((value) => value.text)).not.toContain("bounded-h0")
  expect(reloaded.state.model.entries.map((value) => value.text)).toContain("streamed 99")

  const prepended = InteractiveController.update(reloaded.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 2,
    threadId: thread.id,
    entries: history.slice(0, 100),
    hasOlder: false,
    oldestCursor: cursor(history[0]!),
  })

  expect(prepended.state.entries[0]?.turn.id).toBe("bounded-h0")
  expect(prepended.state.oldestCursor).toEqual(cursor(prepended.state.entries[0]!))
  expect(prepended.state.newestCursor).toEqual(cursor(prepended.state.entries.at(-1)!))
  expect(prepended.state.model.entries.map((value) => value.text)).toContain("bounded-h0")
  expect(prepended.state.hasNewer).toBe(true)
})

it("repaints live patches for the in-flight turn after a reload that renders nothing", () => {
  const active = runningTurn("active")
  const populated = populatedSelection(active)
  const reloaded = InteractiveController.update(populated.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: orphanEntries(active, 5),
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })
  const feed = makeProjectionFeed(
    reloaded.state,
    active,
    TranscriptProjection.Projection.empty(active.id, active.prompt),
  )
  const patched = feed.apply({
    cursor: "answer",
    sequence: 9,
    type: "model.output.completed",
    createdAt: 9,
    text: "live answer",
  })

  const texts = patched.state.model.entries.map((value) => value.text)
  expect(texts).toContain("history answer")
  expect(texts).toContain("live answer")
})

it("seeds the in-flight turn so an empty reload still paints and keeps taking live patches", () => {
  const active = runningTurn("active")
  const reloaded = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [],
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })
  const feed = makeProjectionFeed(
    reloaded.state,
    active,
    TranscriptProjection.Projection.empty(active.id, active.prompt),
  )
  const patched = feed.apply({
    cursor: "answer",
    sequence: 9,
    type: "model.output.completed",
    createdAt: 9,
    text: "live answer",
  })

  expect(reloaded.discarded).toBeUndefined()
  expect(reloaded.state.model.entries.map((value) => value.text)).toEqual(["active prompt"])
  expect(patched.state.model.entries.map((value) => value.text)).toEqual(["active prompt", "live answer"])
})

it("keeps live child patches rendering after a mid-turn selection reload", () => {
  const parentEvents: ReadonlyArray<TranscriptSourceEvent.SourceEvent> = [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review" } },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 5,
      data: { tool_call_id: "agent", child_execution_id: "execution:parent:child:agent" },
    },
  ]
  const running = entries("parent", 2, parentEvents).map(asRunningEntry)
  const turn = running[0]!.turn
  const childId = "parent:child:agent"
  const childReadEvent: TranscriptSourceEvent.SourceEvent = {
    cursor: "child-read",
    sequence: 0,
    type: "tool.call.requested",
    createdAt: 6,
    data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
  }
  const parent = TranscriptProjection.Projection.project(turn.id, turn.prompt, parentEvents)
  let childProjection = TranscriptProjection.Projection.applyEvent(
    TranscriptProjection.Projection.empty(childId, ""),
    childReadEvent,
  )
  const nested = () =>
    TranscriptNestedProjection.withNestedProjections(parent, [
      { parentId: `${turn.id}:agent`, projection: childProjection },
    ])
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: running,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const firstFeed = makeProjectionFeed(selected.state, turn, nested())
  const reloaded = InteractiveController.update(firstFeed.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: running,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const secondFeed = makeProjectionFeed(reloaded.state, turn, nested())
  const childWriteEvent: TranscriptSourceEvent.SourceEvent = {
    cursor: "child-write",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 7,
    data: { tool_call_id: "write", tool_name: "write", input: { path: "src/b.ts" } },
  }
  childProjection = TranscriptProjection.Projection.applyEvent(childProjection, childWriteEvent)
  const resumed = secondFeed.apply(childWriteEvent, {
    executionId: `execution:${childId}`,
    projection: nested(),
  })

  expect(firstFeed.state.model.blocks).toContainEqual(
    expect.objectContaining({ id: TranscriptIdentity.scopedIdentity(childId, "read") }),
  )
  expect(secondFeed.state.model.blocks).toContainEqual(expect.objectContaining({ id: "parent:agent" }))
  expect(secondFeed.state.model.items.length).toBeGreaterThan(0)
  expect(resumed.state.model.blocks).toContainEqual(
    expect.objectContaining({ id: TranscriptIdentity.scopedIdentity(childId, "write") }),
  )
})
