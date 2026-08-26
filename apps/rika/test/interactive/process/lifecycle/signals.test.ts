import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schedule, Stream } from "effect"
import { test } from "vitest"
import { interruptDecision } from "../../../../src/interactive/process/lifecycle/interrupt"
import { lifecycleEvents } from "../../../../src/interactive/process/lifecycle/signals"

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
  const listenerCount = (event: string) => listeners.get(event)?.size ?? 0
  return { on, off, emit, listenerCount }
}

test("first interrupt cancels active work and leaves the session running", () => {
  expect(interruptDecision({ lifecycle: { _tag: "Running" }, hasActiveWork: true, now: 1_000 })).toEqual({
    _tag: "Cancel",
  })
})

test("interrupt without active work quits", () => {
  expect(interruptDecision({ lifecycle: { _tag: "Running" }, hasActiveWork: false, now: 1_000 })).toEqual({
    _tag: "Quit",
  })
})

test("interrupt after a requested cancellation quits instead of cancelling again", () => {
  expect(interruptDecision({ lifecycle: { _tag: "Cancelling" }, hasActiveWork: true, now: 1_000 })).toEqual({
    _tag: "Quit",
  })
})

test("a second interrupt inside the force window escalates to a forced quit", () => {
  expect(
    interruptDecision({
      lifecycle: { _tag: "Quitting", lastInterruptAt: 800 },
      hasActiveWork: false,
      now: 1_000,
    }),
  ).toEqual({ _tag: "ForceQuit" })
})

test("a later interrupt outside the force window keeps waiting on the quit", () => {
  expect(
    interruptDecision({
      lifecycle: { _tag: "Quitting", lastInterruptAt: 500 },
      hasActiveWork: false,
      now: 30_500,
    }),
  ).toEqual({ _tag: "Quit" })
})

test("an interrupt after teardown is ignored", () => {
  expect(interruptDecision({ lifecycle: { _tag: "TornDown" }, hasActiveWork: false, now: 1_000 })).toEqual({
    _tag: "Ignore",
  })
})

it.live("lifecycle events publish signals and release every listener when the scope closes", () =>
  Effect.gen(function* () {
    const emitter = makeEmitter()
    const stdin = makeEmitter()
    const observed: Array<string> = []
    const allObserved = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        lifecycleEvents({ signals: ["SIGINT", "SIGTERM"], stdin, process: emitter }).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              observed.push(event._tag === "Hangup" ? "Hangup" : event.signal)
              if (observed.length === 3) yield* Deferred.succeed(allObserved, undefined)
            }),
          ),
        ),
      ),
    )
    yield* Effect.sync(() => emitter.listenerCount("SIGINT")).pipe(
      Effect.filterOrFail((listeners) => listeners === 1),
      Effect.retry(Schedule.spaced("1 millis")),
      Effect.timeout("1 second"),
    )
    emitter.emit("SIGINT")
    emitter.emit("SIGTERM")
    stdin.emit("end")
    yield* Deferred.await(allObserved).pipe(Effect.timeout("1 second"))
    expect(emitter.listenerCount("SIGINT")).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(observed).toEqual(["SIGINT", "SIGTERM", "Hangup"])
    expect(emitter.listenerCount("SIGINT")).toBe(0)
    expect(emitter.listenerCount("SIGTERM")).toBe(0)
    expect(stdin.listenerCount("end")).toBe(0)
  }),
)
