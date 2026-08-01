import { describe, expect, it } from "@effect/vitest"
import {
  RuntimeFixtures,
  TranscriptFixtures,
  Deferred,
  Effect,
  Ref,
  TestClock,
  ExecutionIngest,
  Operation,
  collectEvents,
  spendThread,
  spendTurnId,
  makeSpendHarness,
} from "./interactive-session-usage-support"

describe("InteractiveSession persisted usage", () => {
  it.effect("never displays more than the persisted total when the same events are delivered again", () =>
    Effect.gen(function* () {
      const { session, usage, follows } = yield* makeSpendHarness({})
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(spendThread.id, 1)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle
      const persisted = yield* usage.readThread(String(spendThread.id))
      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(yield* Ref.get(follows)).toBeGreaterThan(1)
      expect(persisted.costNanoUsd).toBe(750_000_000)
      expect(shown.length).toBeGreaterThan(0)
      expect(Math.max(...shown)).toBe(0.75)
      expect(shown.every((usd) => usd <= 0.75)).toBe(true)
      expect(shown).toEqual([...shown].toSorted((left, right) => left - right))
      const availability = updates.map((event) => event.time._tag)
      expect(availability.slice(availability.indexOf("Available")).includes("Unavailable")).toBe(false)
      expect(updates.at(-1)?.time).toEqual({ _tag: "Available", accumulatedMillis: 30_000 })
      expect(persisted.activeMillis).toBe(30_000)
    }),
  )

  it.effect("holds the displayed total when the persisted projection is reselected", () =>
    Effect.gen(function* () {
      const { session, usage } = yield* makeSpendHarness({ turnStatus: "completed" })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )
      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle
      const persisted = yield* usage.readThread(String(spendThread.id))
      expect(persisted.costNanoUsd).toBe(750_000_000)

      yield* session.selectThread(spendThread.id, 2)
      for (let attempt = 0; attempt < 5; attempt += 1) yield* settle
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(events.some((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 2)).toBe(true)
      const reselectedOrigins = events.flatMap((event) =>
        event._tag === "TranscriptProjectionPatched" && event.selectionEpoch === 2 && event.origin._tag === "Event"
          ? [`${event.origin.executionId}:${event.origin.cursor}:${event.origin.type}`]
          : [],
      )
      expect(new Set(reselectedOrigins).size).toBe(reselectedOrigins.length)
      expect(updates.some((event) => event.selectionEpoch === 2)).toBe(true)
      expect(shown.length).toBeGreaterThan(0)
      expect(Math.max(...shown)).toBe(0.75)
      expect(shown.every((usd) => usd <= 0.75)).toBe(true)
      expect(updates.at(-1)?.cost).toEqual({ _tag: "Available", usd: 0.75, unpricedAttempts: 0 })
      const availability = updates.map((event) => event.time._tag)
      expect(availability.slice(availability.indexOf("Available")).includes("Unavailable")).toBe(false)
      expect((yield* usage.readThread(String(spendThread.id))).costNanoUsd).toBe(750_000_000)
    }),
  )

  it.effect("recomputes cost and elapsed time for a legacy turn whose stored fold is unreadable", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session, usage, transcripts, follows } = yield* makeSpendHarness({
        turnStatus: "completed",
        legacy: true,
        gate,
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )
      expect((yield* transcripts.get(spendTurnId))?.projectionVersion).toBe(
        RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
      )
      expect((yield* transcripts.get(spendTurnId))?.executionCheckpoints).toEqual([])
      expect((yield* usage.readTurn(String(spendTurnId)))?.costNanoUsd).toBe(750_000_000)
      expect((yield* usage.readTurn(String(spendTurnId)))?.activeMillis).toBeUndefined()
      expect((yield* usage.readThread(String(spendThread.id))).activeMillis).toBeUndefined()

      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 5; attempt += 1) yield* settle
      const beforeRefold = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      expect(beforeRefold.length).toBeGreaterThan(0)
      expect(beforeRefold.every((event) => event.time._tag === "Unavailable")).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      const refolded = yield* transcripts.get(spendTurnId)
      const persistedTurn = yield* usage.readTurn(String(spendTurnId))
      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const availability = updates.map((event) => event.time._tag)
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(refolded?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(
        refolded?.executionCheckpoints.find(
          (entry) => entry.executionKey === TranscriptFixtures.TranscriptCorrelation.executionKey(String(spendTurnId)),
        )?.status,
      ).toBe("completed")
      expect(persistedTurn?.activeMillis).toBe(30_000)
      expect(persistedTurn?.costNanoUsd).toBe(750_000_000)
      expect((yield* usage.readThread(String(spendThread.id))).activeMillis).toBe(30_000)
      expect(availability[0]).toBe("Unavailable")
      expect(availability).toContain("Available")
      expect(availability.slice(availability.indexOf("Available")).includes("Unavailable")).toBe(false)
      expect(updates.at(-1)?.time).toEqual({ _tag: "Available", accumulatedMillis: 30_000 })
      expect(shown.length).toBeGreaterThan(0)
      expect(Math.max(...shown)).toBe(0.75)
      expect(shown.every((usd) => usd <= 0.75)).toBe(true)
      expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(yield* Ref.get(follows)).toBe(1)
    }),
  )

  it.effect("announces the refold while a legacy thread rebuilds and withdraws it once the projection lands", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session } = yield* makeSpendHarness({ turnStatus: "completed", legacy: true, gate })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )

      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 5; attempt += 1) yield* settle
      const announced = events.flatMap((event) => (event._tag === "ThreadRefolding" ? [event] : []))
      expect(announced.map((event) => event.refolding)).toEqual([true])
      expect(announced.every((event) => event.threadId === spendThread.id)).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      expect(events.flatMap((event) => (event._tag === "ThreadRefolding" ? [event.refolding] : []))).toEqual([
        true,
        false,
      ])
    }),
  )

  it.effect("loads a selection while ingest catch-up is still blocked", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session, turns, blocked } = yield* makeSpendHarness({ gate, turnStatus: "completed" })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 400 && !events.some((event) => event._tag === "SelectionLoaded"); attempt += 1)
        yield* Effect.yieldNow

      expect(events.some((event) => event._tag === "SelectionLoaded")).toBe(true)
      expect(yield* Ref.get(blocked)).toBeGreaterThan(0)
      expect(yield* turns.get(spendTurnId)).toMatchObject({ status: "completed" })
      yield* Deferred.succeed(gate, undefined)
    }),
  )
})
