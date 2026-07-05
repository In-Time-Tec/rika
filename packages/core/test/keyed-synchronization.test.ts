import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, HashMap, Ref } from "effect"
import { TestClock } from "effect/testing"
import { KeyedSemaphore, SynchronizedMap } from "../src/index"

describe("SynchronizedMap", () => {
  test("creates one value when concurrent get-or-create calls race on the same key", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const map = yield* SynchronizedMap.make<string, number>()
        const created = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const create = () =>
          Ref.update(created, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(42),
          )
        const fiber = yield* Effect.all(
          [SynchronizedMap.getOrCreate(map, "thread", create), SynchronizedMap.getOrCreate(map, "thread", create)],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Deferred.succeed(release, undefined)
        const values = yield* Fiber.join(fiber)
        const createdCount = yield* Ref.get(created)
        return { createdCount, values }
      }),
    )

    expect(result.values).toEqual([42, 42])
    expect(result.createdCount).toBe(1)
  })
})

describe("KeyedSemaphore", () => {
  test("serializes operations on the same key", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const locks = yield* KeyedSemaphore.make<string>()
        const events = yield* Ref.make<Array<string>>([])
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const first = yield* KeyedSemaphore.withPermit(
          locks,
          "orb",
          Ref.update(events, (items) => [...items, "first-enter"]).pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(Ref.update(events, (items) => [...items, "first-exit"])),
          ),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* KeyedSemaphore.withPermit(
          locks,
          "orb",
          Ref.update(events, (items) => [...items, "second-enter"]).pipe(
            Effect.andThen(Deferred.succeed(secondEntered, undefined)),
            Effect.andThen(Ref.update(events, (items) => [...items, "second-exit"])),
          ),
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const secondEnteredBeforeRelease = yield* Deferred.isDone(secondEntered)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        const finalEvents = yield* Ref.get(events)
        return { finalEvents, secondEnteredBeforeRelease }
      }),
    )

    expect(result.secondEnteredBeforeRelease).toBe(false)
    expect(result.finalEvents).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"])
  })

  test("allows operations on different keys to overlap", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const locks = yield* KeyedSemaphore.make<string>()
        const events = yield* Ref.make<Array<string>>([])
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const first = yield* KeyedSemaphore.withPermit(
          locks,
          "orb-a",
          Ref.update(events, (items) => [...items, "first-enter"]).pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(secondEntered)),
            Effect.andThen(Ref.update(events, (items) => [...items, "first-exit"])),
          ),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* KeyedSemaphore.withPermit(
          locks,
          "orb-b",
          Ref.update(events, (items) => [...items, "second-enter"]).pipe(
            Effect.andThen(Deferred.succeed(secondEntered, undefined)),
            Effect.andThen(Ref.update(events, (items) => [...items, "second-exit"])),
          ),
        ).pipe(Effect.forkChild)
        const completed = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
          concurrency: "unbounded",
        }).pipe(Effect.timeoutOption("1 second"), Effect.forkChild)
        yield* TestClock.adjust("1 second")
        const completion = yield* Fiber.join(completed)
        const finalEvents = yield* Ref.get(events)
        return { completion, finalEvents }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.completion._tag).toBe("Some")
    expect(result.finalEvents.slice(0, 2)).toEqual(["first-enter", "second-enter"])
    expect(result.finalEvents).toContain("first-exit")
    expect(result.finalEvents).toContain("second-exit")
  })

  test("remove drops the cached semaphore for a key", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const locks = yield* KeyedSemaphore.make<string>()
        yield* KeyedSemaphore.withPermit(locks, "orb", Effect.void)
        const beforeRemove = yield* semaphoreCount(locks)
        yield* KeyedSemaphore.remove(locks, "orb")
        const afterRemove = yield* semaphoreCount(locks)
        return { beforeRemove, afterRemove }
      }),
    )

    expect(result.beforeRemove).toBe(1)
    expect(result.afterRemove).toBe(0)
  })

  test("remove does not corrupt fibers already waiting on the removed semaphore", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const locks = yield* KeyedSemaphore.make<string>()
        const events = yield* Ref.make<Array<string>>([])
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const first = yield* KeyedSemaphore.withPermit(
          locks,
          "orb",
          Ref.update(events, (items) => [...items, "first-enter"]).pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(Ref.update(events, (items) => [...items, "first-exit"])),
          ),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* KeyedSemaphore.withPermit(
          locks,
          "orb",
          Ref.update(events, (items) => [...items, "second-enter"]).pipe(
            Effect.andThen(Deferred.succeed(secondEntered, undefined)),
            Effect.andThen(Ref.update(events, (items) => [...items, "second-exit"])),
          ),
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* KeyedSemaphore.remove(locks, "orb")
        const sizeAfterRemove = yield* semaphoreCount(locks)
        const secondEnteredBeforeRelease = yield* Deferred.isDone(secondEntered)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        const finalEvents = yield* Ref.get(events)
        return { finalEvents, secondEnteredBeforeRelease, sizeAfterRemove }
      }),
    )

    expect(result.sizeAfterRemove).toBe(0)
    expect(result.secondEnteredBeforeRelease).toBe(false)
    expect(result.finalEvents).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"])
  })
})

const semaphoreCount = <Key>(locks: KeyedSemaphore.KeyedSemaphore<Key>): Effect.Effect<number> =>
  SynchronizedMap.modify(locks.semaphores, (entries) => [HashMap.size(entries), entries] as const)
