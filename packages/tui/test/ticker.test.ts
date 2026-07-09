import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Ticker } from "../src/index"

describe("Ticker", () => {
  test("emits at the fixed cadence under TestClock", async () => {
    const tickCount = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ticker = yield* Ticker.Service
          const countRef = yield* Ref.make(0)

          yield* ticker.ticks.pipe(
            Stream.tap(() => Ref.update(countRef, (value) => value + 1)),
            Stream.take(3),
            Stream.runDrain,
            Effect.forkScoped,
          )

          expect(yield* Ref.get(countRef)).toBe(0)

          yield* TestClock.adjust("32 millis")
          expect(yield* Ref.get(countRef)).toBe(0)

          yield* TestClock.adjust("1 millis")
          expect(yield* Ref.get(countRef)).toBe(1)

          yield* TestClock.adjust("66 millis")
          return yield* Ref.get(countRef)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(Ticker.layer, TestClock.layer()))),
    )

    expect(tickCount).toBe(3)
  })
})
