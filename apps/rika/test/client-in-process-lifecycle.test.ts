import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { runInProcessInteractive } from "../src/client/client-process"

const operation = Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const launches = yield* Ref.make(0)
  const runner = Ref.update(launches, (count) => count + 1).pipe(
    Effect.andThen(Deferred.succeed(started, undefined)),
    Effect.andThen(Effect.never),
    Effect.ensuring(Deferred.succeed(stopped, undefined)),
  )
  return { started, stopped, launches, runner }
})

it.effect("starts one Runner branch and interrupts it when the TUI finishes", () =>
  Effect.gen(function* () {
    const fixture = yield* operation
    expect(
      yield* Effect.scoped(runInProcessInteractive(fixture.runner, Deferred.await(fixture.started))),
    ).toBeUndefined()
    yield* Deferred.await(fixture.stopped)
    expect(yield* Ref.get(fixture.launches)).toBe(1)
  }),
)

it.effect("interrupts the Runner branch when the TUI fails or the operation is interrupted", () =>
  Effect.gen(function* () {
    const failed = yield* operation
    expect(
      yield* Effect.scoped(runInProcessInteractive(failed.runner, Effect.fail("tui failed"))).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      ),
    ).toBe("tui failed")
    yield* Deferred.await(failed.stopped)

    const interrupted = yield* operation
    const fiber = yield* Effect.forkChild(Effect.scoped(runInProcessInteractive(interrupted.runner, Effect.never)))
    yield* Deferred.await(interrupted.started)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(interrupted.stopped)
    expect(yield* Ref.get(interrupted.launches)).toBe(1)
  }),
)
