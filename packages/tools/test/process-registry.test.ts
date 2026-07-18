import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Queue, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ProcessRegistry } from "../src"
import { provide } from "./test-layer"

interface ControlledProcess {
  readonly stdout: Queue.Queue<Uint8Array>
  readonly stderr: Queue.Queue<Uint8Array>
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>
}

const controlledSpawner = (kills: Array<string>) => {
  const spawned: Array<ControlledProcess> = []
  return {
    spawned,
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const stdout = yield* Queue.unbounded<Uint8Array>()
          const stderr = yield* Queue.unbounded<Uint8Array>()
          const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>()
          spawned.push({ stdout, stderr, exit })
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Deferred.await(exit),
            isRunning: Deferred.poll(exit).pipe(Effect.map((value) => value._tag === "None")),
            kill: (options) =>
              Effect.gen(function* () {
                kills.push(options?.killSignal ?? "SIGTERM")
                yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143))
                yield* Queue.shutdown(stdout)
                yield* Queue.shutdown(stderr)
              }),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.fromQueue(stderr),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }),
      ),
    ),
  }
}

const finish = (process: ControlledProcess, exitCode = 0) =>
  Effect.gen(function* () {
    yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(exitCode))
    yield* Queue.shutdown(process.stdout)
    yield* Queue.shutdown(process.stderr)
  })

const bytes = (text: string) => new TextEncoder().encode(text)

describe("ProcessRegistry", () => {
  it.effect("assigns stable ids, returns only new output, and retires completed ids", () => {
    const kills: Array<string> = []
    const spawner = controlledSpawner(kills)
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("command", ["one"], "/workspace")
        const secondId = yield* registry.start("command", ["two"], "/workspace")
        const firstProcess = spawner.spawned[0]!
        yield* Queue.offer(firstProcess.stdout, bytes("first"))
        yield* Effect.yieldNow

        const first = yield* registry.poll(processId, 0, 100)
        const drained = yield* registry.poll(processId, 0, 100)
        yield* Queue.offer(firstProcess.stderr, bytes("second"))
        yield* Effect.yieldNow
        yield* finish(firstProcess, 7)
        const completed = yield* registry.poll(processId, 1_000, 100)
        const retired = yield* Effect.result(registry.poll(processId, 0, 100))
        const unknown = yield* Effect.result(registry.poll("missing", 0, 100))

        expect([processId, secondId]).toEqual(["1", "2"])
        expect(first).toMatchObject({ stdout: "first", stderr: "", running: true, truncated: false })
        expect(drained).toMatchObject({ stdout: "", stderr: "", running: true, truncated: false })
        expect(completed).toMatchObject({ stdout: "", stderr: "second", running: false, exitCode: 7 })
        expect(retired).toMatchObject({ _tag: "Failure", failure: { _tag: "ProcessNotFound" } })
        expect(unknown).toMatchObject({ _tag: "Failure", failure: { _tag: "ProcessNotFound" } })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("bounds retained and returned output while continuing to drain the process", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("large", [], "/workspace")
        const process = spawner.spawned[0]!
        yield* Queue.offer(process.stdout, bytes("x".repeat(ProcessRegistry.pendingOutputLimit + 10_000)))
        yield* Effect.yieldNow

        const bounded = yield* registry.poll(processId, 0, 40_000)
        const drained = yield* registry.poll(processId, 0, 40_000)
        expect(bounded.stdout).toHaveLength(40_000)
        expect(bounded.truncated).toBe(true)
        expect(drained).toMatchObject({ stdout: "", stderr: "", running: true, truncated: false })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("honors poll timeouts without completing a running process", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("slow", [], "/workspace")
        const completed = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          registry.poll(processId, 500, 100).pipe(Effect.tap(() => Deferred.succeed(completed, undefined))),
        )
        yield* TestClock.adjust("499 millis")
        expect((yield* Deferred.poll(completed))._tag).toBe("None")
        yield* TestClock.adjust("1 millis")
        expect(yield* Fiber.join(fiber)).toMatchObject({ processId, running: true })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("terminates every live process with SIGTERM when its owning scope closes", () => {
    const kills: Array<string> = []
    const spawner = controlledSpawner(kills)
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          yield* registry.start("first", [], "/workspace")
          yield* registry.start("second", [], "/workspace")
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
      )
      expect(kills).toEqual(["SIGTERM", "SIGTERM"])
    })
  })
})
