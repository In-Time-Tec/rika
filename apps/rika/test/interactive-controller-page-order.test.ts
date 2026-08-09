import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { maxInMemoryTranscriptUnits } from "@rika/terminal/terminal-timeline-bounds"
import { makeThreadViewFeed } from "@rika/product/interactive-thread-view-feed"
import { it, expect } from "vitest"
import { thread, entries, initialState } from "./interactive-controller-transcript-fixtures"

const entry = (unitKey: string, sequence: number, text: string) => ({
  turn: entries("partial", 2)[0]!.turn,
  unit: {
    key: unitKey,
    turnId: String(entries("partial", 2)[0]!.turn.id),
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

it("projects a full snapshot beyond the old 120-unit window bound without truncation", () => {
  const feed = makeThreadViewFeed(() => 1)
  const selected = feed.publish({
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [
      entry("opening", 1, "opening"),
      ...Array.from({ length: 128 }, (_, index) => entry(`unit:${index}`, index + 2, `unit ${index}`)),
      entry("final", 200, "final"),
    ],
    hasOlder: true,
    usage: { usage: ExecutionProjection.emptyUsageState() },
  })

  let state = initialState()
  // The feed emits every client event; the controller projects the transcript ones.
  for (const event of selected)
    if (
      event._tag === "ThreadViewSnapshot" ||
      event._tag === "ThreadViewPatch" ||
      event._tag === "ResyncRequired" ||
      event._tag === "ThreadRefolding"
    )
      state = InteractiveController.update(state, event).state

  const keys = state.view?.turns.flatMap((value) => value.units.map((unit) => unit.key)) ?? []
  expect(keys).toHaveLength(130)
  expect(keys[0]).toBe("opening")
  expect(keys.at(-1)).toBe("final")
  expect(state.model.entries.map((value) => value.text)).toEqual([
    "opening",
    ...Array.from({ length: 128 }, (_, index) => `unit ${index}`),
    "final",
  ])
})

it("bounds the in-memory timeline to the newest units when a snapshot exceeds the cap", () => {
  const feed = makeThreadViewFeed(() => 1)
  const turn = entries("huge", 1)[0]!.turn
  const units = Array.from({ length: maxInMemoryTranscriptUnits + 5 }, (_, index) => {
    const key = `unit:${String(index).padStart(6, "0")}`
    return {
      turn,
      unit: {
        key,
        turnId: String(turn.id),
        order: TranscriptOrdering.unitOrder(key, index),
        revision: index,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: key },
      },
      projectionRevision: 1,
      projectionModelPhase: -1,
      projectionState: {
        status: "completed" as const,
        usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true },
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
  })
  const selected = feed.publish({
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: units,
    hasOlder: false,
    usage: { usage: ExecutionProjection.emptyUsageState() },
  })

  let state = initialState()
  // The feed emits every client event; the controller projects the transcript ones.
  for (const event of selected)
    if (
      event._tag === "ThreadViewSnapshot" ||
      event._tag === "ThreadViewPatch" ||
      event._tag === "ResyncRequired" ||
      event._tag === "ThreadRefolding"
    )
      state = InteractiveController.update(state, event).state

  expect(state.model.items.length).toBe(maxInMemoryTranscriptUnits)
  expect(state.model.entries[0]?.text).toBe(`unit:${String(5).padStart(6, "0")}`)
  expect(state.model.entries.at(-1)?.text).toBe(`unit:${String(maxInMemoryTranscriptUnits + 4).padStart(6, "0")}`)
})
