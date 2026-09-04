import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Exit, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeFrameScheduler } from "../../../../src/interactive/process/lifecycle/frame-scheduler"

// Characterization tests for the frame scheduler (defect: every model change
// renders synchronously instead of coalescing into one commit per frame).
// The scheduler module lands with the production rewrite; these tests fail as
// missing-module failures until then. They use a manual Effect clock, so no
// wall-clock timing is involved.

interface Snapshot {
  readonly revision: number
}

const setup = Effect.gen(function* () {
  const commits = yield* Ref.make<Array<number>>([])
  const seenRenderers = yield* Ref.make<Array<unknown>>([])
  const seenRoots = yield* Ref.make<Array<unknown>>([])
  const scheduler = yield* makeFrameScheduler({
    frameMillis: 16,
    render: (commit: { readonly revision: number; readonly renderer: unknown; readonly root: unknown }) =>
      Effect.gen(function* () {
        yield* Ref.update(commits, (all) => [...all, commit.revision])
        yield* Ref.update(seenRenderers, (all) => [...all, commit.renderer])
        yield* Ref.update(seenRoots, (all) => [...all, commit.root])
      }),
  })
  const request = (revision: number): Effect.Effect<void> => scheduler.request({ revision } satisfies Snapshot)
  return { commits, seenRenderers, seenRoots, scheduler, request }
})

describe("FrameScheduler", () => {
  it.effect("coalesces one hundred model changes into one frame interval", () =>
    Effect.gen(function* () {
      const { commits, request } = yield* setup
      for (let revision = 1; revision <= 100; revision += 1) {
        yield* request(revision)
      }
      yield* TestClock.adjust("16 millis")
      yield* Effect.yieldNow
      expect(yield* Ref.get(commits)).toHaveLength(1)
    }),
  )

  it.effect("retains only the newest pending model snapshot", () =>
    Effect.gen(function* () {
      const { commits, request } = yield* setup
      for (let revision = 1; revision <= 100; revision += 1) {
        yield* request(revision)
      }
      yield* TestClock.adjust("16 millis")
      yield* Effect.yieldNow
      const committed = yield* Ref.get(commits)
      expect(committed.at(-1)).toBe(100)
    }),
  )

  it.effect("never commits after its owning scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const commits = yield* Ref.make<Array<number>>([])
        const scheduler = yield* Scope.extend(
          makeFrameScheduler({
            frameMillis: 16,
            render: (commit: { readonly revision: number }) =>
              Ref.update(commits, (all) => [...all, commit.revision]),
          }),
          scope,
        )
        yield* scheduler.request({ revision: 1 })
        yield* Scope.close(scope, Exit.void)
        yield* TestClock.adjust("32 millis")
        yield* Effect.yieldNow
        expect(yield* Ref.get(commits)).toHaveLength(0)
      }),
    ),
  )

  it.effect("uses one renderer and one root across one hundred picker cycles", () =>
    Effect.gen(function* () {
      const { commits, seenRenderers, seenRoots, request } = yield* setup
      for (let cycle = 0; cycle < 100; cycle += 1) {
        yield* request(cycle)
        yield* TestClock.adjust("16 millis")
      }
      yield* Effect.yieldNow
      expect(yield* Ref.get(commits)).toHaveLength(100)
      expect(new Set(yield* Ref.get(seenRenderers)).size).toBe(1)
      expect(new Set(yield* Ref.get(seenRoots)).size).toBe(1)
    }),
  )

  it.effect("does not render idle unchanged state", () =>
    Effect.gen(function* () {
      const { commits } = yield* setup
      yield* TestClock.adjust("16 millis")
      yield* TestClock.adjust("32 millis")
      yield* TestClock.adjust("64 millis")
      yield* Effect.yieldNow
      expect(yield* Ref.get(commits)).toHaveLength(0)
    }),
  )

  it.effect("keeps frame latency within two frame intervals", () =>
    Effect.gen(function* () {
      const { commits, request } = yield* setup
      yield* request(1)
      yield* TestClock.adjust("32 millis")
      yield* Effect.yieldNow
      expect(yield* Ref.get(commits)).toEqual([1])
    }),
  )
})
