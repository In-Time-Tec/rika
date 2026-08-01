import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import { expect, it } from "vitest"
import { thread, entries, asRunningEntry, initialState } from "./interactive-controller-transcript-fixtures"
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
