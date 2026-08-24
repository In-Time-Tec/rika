import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schedule, Stream } from "effect"
import { installClientSigintHandler } from "../src/client/client-process"
import { makeSigintOwnership } from "../src/client/client-signal-ownership"
import { lifecycleEvents } from "../src/interactive/process/process-signals"

const makeEmitter = () => {
  const listeners = new Map<string, Set<() => void>>()
  const on = (event: string, listener: () => void) => {
    const eventListeners = listeners.get(event) ?? new Set()
    eventListeners.add(listener)
    listeners.set(event, eventListeners)
  }
  const off = (event: string, listener: () => void) => {
    listeners.get(event)?.delete(listener)
  }
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  return { on, off, emit }
}

it.live("hands SIGINT from the root to the TUI only while its watcher owns listeners", () =>
  Effect.gen(function* () {
    const ownership = makeSigintOwnership()
    const emitter = makeEmitter()
    const stdin = makeEmitter()
    let rootInterrupts = 0
    let tuiInterrupts = 0
    const removeRoot = installClientSigintHandler({
      rootFiber: () => ({ interruptUnsafe: () => rootInterrupts++ }),
      onSignal: () => undefined,
      ownership,
      process: emitter,
    })

    emitter.emit("SIGINT")
    expect(rootInterrupts).toBe(1)

    const observed = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        lifecycleEvents({ signals: ["SIGINT"], stdin, process: emitter, ownership }).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => tuiInterrupts++).pipe(Effect.andThen(Deferred.succeed(observed, undefined))),
          ),
        ),
      ),
    )
    yield* Effect.sync(() => ownership.rootOwns()).pipe(
      Effect.filterOrFail((owns) => !owns),
      Effect.retry(Schedule.spaced("1 millis")),
      Effect.timeout("1 second"),
    )
    emitter.emit("SIGINT")
    yield* Deferred.await(observed).pipe(Effect.timeout("1 second"))
    expect(rootInterrupts).toBe(1)
    expect(tuiInterrupts).toBe(1)

    yield* Fiber.interrupt(fiber)
    expect(ownership.rootOwns()).toBe(true)
    emitter.emit("SIGINT")
    expect(rootInterrupts).toBe(2)
    expect(tuiInterrupts).toBe(1)
    removeRoot()
    emitter.emit("SIGINT")
    expect(rootInterrupts).toBe(2)
  }),
)
