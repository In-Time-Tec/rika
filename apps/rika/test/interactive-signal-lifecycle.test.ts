import { EventEmitter } from "node:events"
import { expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Stream } from "effect"
import { test } from "vitest"
import { interruptDecision } from "../src/interactive/process/process-interrupt"
import { lifecycleEvents } from "../src/interactive/process/process-signals"

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
    const emitter = new EventEmitter()
    const stdin = new EventEmitter() as unknown as NodeJS.ReadStream
    const observed: Array<string> = []
    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        lifecycleEvents({ signals: ["SIGINT", "SIGTERM"], stdin, process: emitter }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              observed.push(event._tag === "Hangup" ? "Hangup" : event.signal)
            }),
          ),
        ),
      ),
    )
    yield* Effect.sleep(Duration.millis(50))
    emitter.emit("SIGINT")
    emitter.emit("SIGTERM")
    ;(stdin as unknown as EventEmitter).emit("end")
    yield* Effect.sleep(Duration.millis(100))
    expect(emitter.listenerCount("SIGINT")).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(observed).toEqual(["SIGINT", "SIGTERM", "Hangup"])
    expect(emitter.listenerCount("SIGINT")).toBe(0)
    expect(emitter.listenerCount("SIGTERM")).toBe(0)
    expect((stdin as unknown as EventEmitter).listenerCount("end")).toBe(0)
  }),
)
