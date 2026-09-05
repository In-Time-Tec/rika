import * as InteractiveController from "../../../src/interactive/controller/service"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { makeThreadViewFeed } from "@rika/product/interactive-thread-view-feed"
import { it, expect } from "vitest"
import { thread, entries, initialState } from "./feed.fixture"

const formerTimelineLimit = 20_000

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

it("keeps a reconnected waiting Turn waiting instead of showing stale assistant activity", () => {
  const feed = makeThreadViewFeed(() => 1)
  const source = entry("assistant", 1, "Checking the operation")
  const selected = feed.publish({
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    projectionCheckpoints: [],
    thread,
    entries: [
      {
        ...source,
        turn: { ...source.turn, status: "waiting" },
        projectionState: { ...source.projectionState, status: "waiting", needsResolution: true },
      },
      {
        ...source,
        turn: { ...source.turn, status: "waiting" },
        projectionState: { ...source.projectionState, status: "waiting", needsResolution: true },
        unit: {
          ...source.unit,
          key: "operation:notice",
          order: TranscriptOrdering.unitOrder("operation:notice", 2),
          content: {
            _tag: "Block",
            block: {
              _tag: "Notification",
              title: "Waiting for operation recovery",
              detail: "Run: run-1; operation: op-1.",
            },
          },
        },
      },
    ],
    hasOlder: false,
    usage: { usage: ExecutionProjection.emptyUsageState() },
  })
  let state = initialState()
  for (const event of selected)
    if (event._tag === "ThreadViewSnapshot") state = InteractiveController.update(state, event).state
  expect(state.model.busy).toBe(true)
  expect(state.model.activity).toEqual({ _tag: "Waiting" })
  expect(state.model.blocks).toContainEqual({
    _tag: "Notification",
    title: "Waiting for operation recovery",
    detail: "Run: run-1; operation: op-1.",
  })
  const reconnected = initialState()
  const snapshot = selected.find((event) => event._tag === "ThreadViewSnapshot")
  if (snapshot?._tag !== "ThreadViewSnapshot") throw new Error("Missing snapshot")
  const restored = InteractiveController.update(reconnected, structuredClone(snapshot))
  expect(restored.state.model.blocks).toEqual(state.model.blocks)
  expect(restored.state.model.activity).toEqual({ _tag: "Waiting" })
  // Old snapshots have no signal: a historical notice must not act as execution authority.
  const ordinary = {
    ...snapshot,
    snapshot: { ...snapshot.snapshot, turns: snapshot.snapshot.turns.map(({ needsResolution: _, ...turn }) => turn) },
  }
  expect(InteractiveController.update(initialState(), ordinary).state.model.activity?._tag).not.toBe("Waiting")
})

it("projects a full snapshot beyond the old 120-unit window bound without truncation", () => {
  const feed = makeThreadViewFeed(() => 1)
  const selected = feed.publish({
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    projectionCheckpoints: [],
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

  const keys = state.view?.snapshot().turns.flatMap((value) => value.units.map((unit) => unit.key)) ?? []
  expect(keys).toHaveLength(130)
  expect(keys[0]).toBe("opening")
  expect(keys.at(-1)).toBe("final")
  expect(state.model.transcriptTruncated).toBe(true)
  expect(state.model.entries.map((value) => value.text)).toEqual([
    "opening",
    ...Array.from({ length: 128 }, (_, index) => `unit ${index}`),
    "final",
  ])
})

it("retains every unit when a snapshot exceeds the former in-memory cap", () => {
  const feed = makeThreadViewFeed(() => 1)
  const turn = entries("huge", 1)[0]!.turn
  const units = Array.from({ length: formerTimelineLimit + 5 }, (_, index) => {
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
    projectionCheckpoints: [],
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

  expect(state.model.items.length).toBe(formerTimelineLimit + 5)
  expect(state.model.transcriptTruncated).toBe(false)
  expect(state.model.entries[0]?.text).toBe("unit:000000")
  expect(state.model.entries.at(-1)?.text).toBe(`unit:${String(formerTimelineLimit + 4).padStart(6, "0")}`)
})
