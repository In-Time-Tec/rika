import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { makeThreadViewFeed } from "@rika/product/interactive-thread-view-feed"
import { it, expect } from "vitest"
import { thread, entries, initialState } from "./interactive-controller-transcript-fixtures"

it("inserts an older partial Turn page between retained opening and final entries", () => {
  const base = entries("partial", 2)
  const turn = base[0]!.turn
  const entry = (unitKey: string, sequence: number, text: string) => ({
    turn,
    unit: {
      key: unitKey,
      turnId: String(turn.id),
      order: TranscriptOrdering.unitOrder(unitKey, sequence),
      revision: sequence,
      content: { _tag: "Entry" as const, role: "assistant" as const, text },
    },
    projectionRevision: 222,
    projectionModelPhase: 0,
    projectionState: {
      status: "running" as const,
      usage: ExecutionProjection.emptyUsageState(),
      steering: { steeringMessages: 0, followUpMessages: 0 },
    },
  })
  const feed = makeThreadViewFeed(() => 1)
  const selected = feed.publish({
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [entry("opening", 1, "opening"), entry("final", 222, "final")],
    hasOlder: true,
    usage: { usage: ExecutionProjection.emptyUsageState() },
  })
  const prepended = feed.publish({
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [entry("middle-3", 3, "middle 3"), entry("middle-2", 2, "middle 2")],
    hasOlder: false,
  })

  let state = initialState()
  for (const event of [...selected, ...prepended]) state = InteractiveController.update(state, event).state

  expect(state.view?.turns.flatMap((value) => value.units.map((unit) => unit.key))).toEqual([
    "opening",
    "middle-2",
    "middle-3",
    "final",
  ])
  expect(state.model.entries.map((value) => value.text)).toEqual(["opening", "middle 2", "middle 3", "final"])
})

it("moves contiguously from five older units into a 125-unit newest Turn", () => {
  const makePage = (id: string, createdAt: number, count: number) => {
    const currentTurn = entries(id, createdAt)[0]!.turn
    return Array.from({ length: count }, (_, index) => {
      const key = `${id}-${String(index).padStart(3, "0")}`
      return {
        turn: currentTurn,
        unit: {
          key,
          turnId: currentTurn.id,
          order: TranscriptOrdering.unitOrder(key, index),
          revision: index,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: key },
        },
        projectionRevision: count,
        projectionModelPhase: -1,
        projectionState: {
          status: "completed" as const,
          usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true },
          steering: { steeringMessages: 0, followUpMessages: 0 },
        },
      }
    })
  }
  const cursor = (entry: ReturnType<typeof makePage>[number]) => ({
    createdAt: entry.turn.createdAt,
    turnId: entry.turn.id,
    orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
  })
  const older = makePage("older", 1, 5)
  const newest = makePage("newest", 2, 125)
  const feed = makeThreadViewFeed(() => 1)
  const runtimeEvents = [
    {
      _tag: "SelectionLoaded" as const,
      selectionEpoch: 1,
      activitySequence: 0,
      queueRevision: 0,
      queue: [],
      thread,
      entries: newest.slice(5),
      hasOlder: true,
      hasNewer: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      oldestCursor: cursor(newest[5]!),
      newestCursor: cursor(newest[124]!),
    },
    {
      _tag: "TranscriptPagePrepended" as const,
      selectionEpoch: 1,
      threadId: thread.id,
      entries: [...older, ...newest.slice(0, 5)],
      hasOlder: false,
      oldestCursor: cursor(older[0]!),
    },
    {
      _tag: "TranscriptPageAppended" as const,
      selectionEpoch: 1,
      threadId: thread.id,
      entries: newest.slice(115),
      hasNewer: false,
      requestedAfter: cursor(newest[114]!),
      newestCursor: cursor(newest[124]!),
    },
  ]

  let state = initialState()
  for (const runtimeEvent of runtimeEvents)
    for (const event of feed.publish(runtimeEvent)) state = InteractiveController.update(state, event).state

  // Prepend keeps the oldest edge (older Turn plus the first 115 units of the newest Turn), and the
  // appended tail then slides the window to the newest 120 units: contiguous, nothing lost, and the
  // older page becomes reachable again through hasOlder.
  const visibleKeys = state.view?.turns.flatMap((value) => value.units.map((unit) => unit.key)) ?? []
  expect(visibleKeys).toEqual(newest.slice(5).map((entry) => entry.unit.key))
  expect(new Set(visibleKeys).size).toBe(120)
  expect(state.view).toMatchObject({
    hasOlder: true,
    hasNewer: false,
    source: { oldestCursor: cursor(newest[5]!), newestCursor: cursor(newest[124]!) },
  })
  expect(state.model.entries.map((value) => value.text)).toEqual(visibleKeys)
})
