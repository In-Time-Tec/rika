import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Ref } from "effect"
import * as ServerService from "../src/server/server-service"
describe("Rika Server lifecycle", () => {
  it.effect("cancels grace when another authenticated client attaches", () =>
    Effect.gen(function* () {
      const states = yield* Effect.gen(function* () {
        const observed = yield* Ref.make<Array<string>>([])
        const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle((state) =>
          Ref.update(observed, (values) => [...values, state]),
        )
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        yield* lifecycle.detach
        yield* lifecycle.tryAttach
        return yield* Ref.get(observed)
      }).pipe(Effect.withSpan("ServerService.test"))
      expect(states).toEqual(["ready", "grace", "ready"])
    }),
  )

  it.effect("drains only after the final client grace expires", () =>
    Effect.gen(function* () {
      const state = yield* Effect.gen(function* () {
        const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
        yield* lifecycle.tryAttach
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        yield* lifecycle.detach
        yield* lifecycle.expireGrace(0)
        expect(yield* lifecycle.state).toBe("ready")
        const generation = yield* lifecycle.detach
        expect(generation).toBeDefined()
        yield* lifecycle.expireGrace(generation!)
        return yield* lifecycle.state
      }).pipe(Effect.withSpan("ServerService.test"))
      expect(state).toBe("draining")
    }),
  )

  it.effect("does not let a stale grace timer stop a reattached service", () =>
    Effect.gen(function* () {
      const state = yield* Effect.gen(function* () {
        const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        const stale = yield* lifecycle.detach
        yield* lifecycle.tryAttach
        yield* lifecycle.detach
        expect(yield* lifecycle.expireGrace(stale!)).toBe(false)
        return yield* lifecycle.state
      }).pipe(Effect.withSpan("ServerService.test"))
      expect(state).toBe("grace")
    }),
  )

  it.effect("never admits a client after draining starts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
        expect(yield* lifecycle.tryAttach).toBe(true)
        yield* lifecycle.ready
        const generation = yield* lifecycle.detach
        expect(yield* lifecycle.expireGrace(generation!)).toBe(true)
        const attached = yield* lifecycle.tryAttach
        yield* lifecycle.ready
        return { attached, state: yield* lifecycle.state }
      }).pipe(Effect.withSpan("ServerService.test"))
      expect(result).toEqual({ attached: false, state: "draining" })
    }),
  )

  it.effect("begins cooperative drain monotonically", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
        expect(yield* lifecycle.tryAttach).toBe(true)
        yield* lifecycle.ready
        yield* lifecycle.beginDrain
        yield* lifecycle.ready
        return { attached: yield* lifecycle.tryAttach, state: yield* lifecycle.state }
      }).pipe(Effect.withSpan("ServerService.test"))
      expect(result).toEqual({ attached: false, state: "draining" })
    }),
  )

  it.effect("never reports ready after draining starts", () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<Array<string>>([])
      const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle((state) =>
        Ref.update(observed, (states) => [...states, state]),
      )
      yield* lifecycle.tryAttach
      yield* lifecycle.ready
      yield* lifecycle.beginDrain
      yield* lifecycle.ready
      yield* lifecycle.stopped
      yield* lifecycle.ready
      expect(yield* Ref.get(observed)).toEqual(["ready", "draining", "stopped"])
    }),
  )

  it.effect("atomically rejects work once draining starts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
          const fibers = yield* FiberSet.make<void>()
          yield* lifecycle.ready
          yield* lifecycle.beginDrain
          const fiber = yield* lifecycle.runWork(fibers, Effect.void)
          return { admitted: fiber !== undefined, size: yield* FiberSet.size(fibers) }
        }),
      )
      expect(result).toEqual({ admitted: false, size: 0 })
    }),
  )

  it.effect("serializes work admission with drain and lets the host interrupt accepted work", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
          const fibers = yield* FiberSet.make<void>()
          const started = yield* Deferred.make<void>()
          const finalized = yield* Deferred.make<void>()
          yield* lifecycle.ready
          const fiber = yield* lifecycle.runWork(
            fibers,
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
          )
          expect(fiber).toBeDefined()
          yield* Deferred.await(started)
          yield* lifecycle.beginDrain
          yield* FiberSet.clear(fibers)
          yield* FiberSet.awaitEmpty(fibers)
          const exit = yield* Fiber.await(fiber!)
          return {
            interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
            finalized: yield* Deferred.isDone(finalized),
            admittedAfterDrain: (yield* lifecycle.runWork(fibers, Effect.void)) !== undefined,
          }
        }),
      )
      expect(result).toEqual({ interrupted: true, finalized: true, admittedAfterDrain: false })
    }),
  )

  it.effect("keeps work admission closed after an idle replacement decision", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
      const inspectionStarted = yield* Deferred.make<void>()
      const finishInspection = yield* Deferred.make<void>()
      yield* lifecycle.ready
      const decision = yield* Effect.forkChild(
        lifecycle.authorizeReplacement(
          Deferred.succeed(inspectionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishInspection)),
            Effect.as(false),
          ),
        ),
      )
      yield* Deferred.await(inspectionStarted)
      const admissionCompleted = yield* Deferred.make<void>()
      const admission = yield* Effect.forkChild(
        lifecycle.reserveReplacementWork.pipe(Effect.tap(() => Deferred.succeed(admissionCompleted, undefined))),
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(admissionCompleted)).toBe(false)
      yield* Deferred.succeed(finishInspection, undefined)
      expect(yield* Fiber.join(decision)).toBe("supersede")
      expect(yield* Fiber.join(admission)).toBeUndefined()
      expect(yield* lifecycle.state).toBe("draining")
    }),
  )

  it.effect("blocks attachment during replacement inspection and refuses it after authorization", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
      const inspectionStarted = yield* Deferred.make<void>()
      const finishInspection = yield* Deferred.make<void>()
      yield* lifecycle.ready
      const decision = yield* Effect.forkChild(
        lifecycle.authorizeReplacement(
          Deferred.succeed(inspectionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishInspection)),
            Effect.as(false),
          ),
        ),
      )
      yield* Deferred.await(inspectionStarted)
      const attachCompleted = yield* Deferred.make<void>()
      const attachment = yield* Effect.forkChild(
        lifecycle.tryAttach.pipe(Effect.tap(() => Deferred.succeed(attachCompleted, undefined))),
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(attachCompleted)).toBe(false)
      yield* Deferred.succeed(finishInspection, undefined)
      expect(yield* Fiber.join(decision)).toBe("supersede")
      expect(yield* Fiber.join(attachment)).toBe(false)
    }),
  )

  it.effect("defers for admitted work, leaves the server usable, and authorizes retry after release", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
      yield* lifecycle.ready
      const release = yield* lifecycle.reserveReplacementWork
      expect(release).toBeDefined()
      expect(yield* lifecycle.authorizeReplacement(Effect.succeed(false))).toBe("defer")
      expect(yield* lifecycle.state).not.toBe("draining")
      yield* release!
      const next = yield* lifecycle.reserveReplacementWork
      expect(next).toBeDefined()
      yield* next!
      expect(yield* lifecycle.authorizeReplacement(Effect.succeed(false))).toBe("supersede")
      expect(yield* lifecycle.state).toBe("draining")
    }),
  )
})
