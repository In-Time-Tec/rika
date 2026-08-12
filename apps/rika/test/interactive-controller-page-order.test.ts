import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { maxInMemoryTranscriptUnits } from "@rika/terminal/terminal-timeline-bounds"
import { makeThreadViewFeed } from "@rika/product/interactive-thread-view-feed"
import * as LiveThreadProjection from "@rika/product/live-thread-projection"
import { Effect, Stream } from "effect"
import { it, expect } from "@effect/vitest"
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

it.effect("projects a full snapshot beyond the old 120-unit window bound without truncation", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    const feed = makeThreadViewFeed(hub)
    feed.publish({
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
    const base = yield* Stream.runCollect(hub.watch(thread.id).pipe(Stream.take(1)))
    const frame = base[0]
    if (frame === undefined || frame._tag !== "Base" || frame.base === undefined)
      return yield* Effect.die("hub did not emit an atomic base")
    let state = initialState()
    for (const event of feed.publish({
      _tag: "ThreadViewHubBase",
      threadId: thread.id,
      generation: frame.generation,
      base: frame.base,
      live: undefined,
    }))
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
  }),
)

it.effect("bounds the in-memory timeline to the newest units when a snapshot exceeds the cap", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    const feed = makeThreadViewFeed(hub)
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
    feed.publish({
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
    const base = yield* Stream.runCollect(hub.watch(thread.id).pipe(Stream.take(1)))
    const frame = base[0]
    if (frame === undefined || frame._tag !== "Base" || frame.base === undefined)
      return yield* Effect.die("hub did not emit an atomic base")
    let state = initialState()
    for (const event of feed.publish({
      _tag: "ThreadViewHubBase",
      threadId: thread.id,
      generation: frame.generation,
      base: frame.base,
      live: undefined,
    }))
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
  }),
)
