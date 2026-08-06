import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { collectEvents } from "./interactive-session-base-support"
import { spendThread, makeSpendHarness } from "./interactive-session-usage-support"

describe("InteractiveSession persisted usage", () => {
  it.effect("never displays more than the persisted total when the same events are delivered again", () =>
    Effect.gen(function* () {
      const { session, usage, follows } = yield* makeSpendHarness({})
      const events: Array<InteractiveEvent> = []
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
      const contexts = updates.map((event) => event.context._tag)
      expect(contexts).toContain("Available")
      expect(persisted.activeMillis).toBe(30_000)
    }),
  )
})
