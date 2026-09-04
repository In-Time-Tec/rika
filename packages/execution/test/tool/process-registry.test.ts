import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Queue, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as ProcessRegistry from "../../src/tool/process-registry"
import { RuntimeFilesystem } from "../../src/tool/filesystem"
import { provide } from "./support"

interface ControlledProcess {
  readonly stdoutQueue: Queue.Queue<Uint8Array>
  readonly stderrQueue: Queue.Queue<Uint8Array>
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
          spawned.push({ stdoutQueue: stdout, stderrQueue: stderr, exit })
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
    yield* Queue.shutdown(process.stdoutQueue)
    yield* Queue.shutdown(process.stderrQueue)
  })

const bytes = (text: string) => new TextEncoder().encode(text)
const keptFirstBytes = (output: string): number => {
  const match = /kept first (\d+) of (\d+) bytes/.exec(output)
  if (match?.[1] === undefined) throw new Error("expected a truncation marker reporting kept bytes")
  return Number(match[1])
}

const instrumentByteLength = () => {
  const original = RuntimeFilesystem.byteLength
  const inputs: Array<string> = []
  let total = 0
  RuntimeFilesystem.byteLength = (text: string) => {
    inputs.push(text)
    const size = original(text)
    total += size
    return size
  }
  return {
    inputs,
    total: () => total,
    restore: () => {
      RuntimeFilesystem.byteLength = original
    },
  }
}


describe("ProcessRegistry", () => {
  it.effect("assigns stable ids, returns only new running output, and repeats the terminal result", () => {
    const kills: Array<string> = []
    const spawner = controlledSpawner(kills)
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("command", ["one"], "/workspace")
        const secondId = yield* registry.start("command", ["two"], "/workspace")
        const firstProcess = spawner.spawned[0]!
        yield* Queue.offer(firstProcess.stdoutQueue, bytes("first"))
        yield* Effect.yieldNow

        const first = yield* registry.poll(processId, 0, 100)
        const drained = yield* registry.poll(processId, 0, 100)
        yield* Queue.offer(firstProcess.stderrQueue, bytes("second"))
        yield* Effect.yieldNow
        yield* finish(firstProcess, 7)
        const completed = yield* registry.poll(processId, 1_000, 100)
        const repeated = yield* registry.poll(processId, 0, 100)
        const unknown = yield* Effect.result(registry.poll("missing", 0, 100))

        expect([processId, secondId]).toEqual(["1", "2"])
        expect(first).toMatchObject({ stdout: "first", stderr: "", running: true, truncated: false })
        expect(drained).toMatchObject({ stdout: "", stderr: "", running: true, truncated: false })
        expect(completed).toMatchObject({ stdout: "", stderr: "second", running: false, exitCode: 7 })
        expect(repeated).toEqual(completed)
        expect(unknown).toMatchObject({ _tag: "Failure", failure: { _tag: "ProcessNotFound" } })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("keeps fast completion output readable through repeated status checks", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("fast", [], "/workspace")
        const process = spawner.spawned[0]!
        yield* Queue.offer(process.stdoutQueue, bytes("completed immediately"))
        yield* Effect.yieldNow
        yield* finish(process)
        yield* Effect.yieldNow

        const completed = yield* registry.poll(processId, 0, 100)
        const repeated = yield* registry.poll(processId, 0, 100)

        expect(completed).toMatchObject({
          processId,
          stdout: "completed immediately",
          running: false,
          exitCode: 0,
        })
        expect(repeated).toEqual(completed)
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
        yield* Queue.offer(process.stdoutQueue, bytes("x".repeat(ProcessRegistry.pendingOutputLimit + 10_000)))
        yield* Effect.yieldNow

        const bounded = yield* registry.poll(processId, 0, 40_000)
        const drained = yield* registry.poll(processId, 0, 40_000)
        expect(new TextEncoder().encode(bounded.stdout).byteLength).toBeLessThanOrEqual(40_000)
        expect(bounded.stdout).toContain("[truncated: kept first")
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
        yield* Queue.offer(spawner.spawned[0]!.stdoutQueue, bytes("still working"))
        yield* Effect.yieldNow
        const completed = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          registry.poll(processId, 500, 100).pipe(Effect.tap(() => Deferred.succeed(completed, undefined))),
        )
        yield* TestClock.adjust("499 millis")
        expect((yield* Deferred.poll(completed))._tag).toBe("None")
        yield* TestClock.adjust("1 millis")
        expect(yield* Fiber.join(fiber)).toMatchObject({
          processId,
          stdout: "still working",
          running: true,
          elapsedMillis: 500,
        })
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("bounds retained terminal results without evicting active processes", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const activeId = yield* registry.start("active", [], "/workspace")
        const activeProcess = spawner.spawned[0]!
        const processIds: Array<string> = []
        for (let index = 0; index <= 128; index++) {
          const processId = yield* registry.start("fast", [String(index)], "/workspace")
          processIds.push(processId)
          const process = spawner.spawned[index + 1]!
          yield* Queue.offer(process.stdoutQueue, bytes(String(index)))
          yield* Effect.yieldNow
          yield* finish(process)
          yield* registry.poll(processId, 1_000, 100)
        }

        yield* Queue.offer(activeProcess.stdoutQueue, bytes("still active"))
        yield* Effect.yieldNow

        expect(yield* Effect.result(registry.poll(processIds[0]!, 0, 100))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProcessNotFound" },
        })
        expect(yield* registry.poll(activeId, 0, 100)).toMatchObject({
          stdout: "still active",
          running: true,
        })
        expect(yield* registry.poll(processIds.at(-1)!, 0, 100)).toMatchObject({
          stdout: "128",
          running: false,
          exitCode: 0,
        })
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

  it.effect("keeps a UTF-8 byte limit across ten thousand output chunks", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("large", [], "/workspace")
        const process = spawner.spawned[0]!
        const chunk = "日本語"
        const chunks = 10_000
        for (let index = 0; index < chunks; index += 1) {
          yield* Queue.offer(process.stdoutQueue, bytes(chunk))
        }
        yield* Effect.yieldNow
        yield* finish(process)
        const completed = yield* registry.poll(processId, 5_000, 1_000_000)
        const sourceBytes = chunks * new TextEncoder().encode(chunk).byteLength
        expect(sourceBytes).toBeGreaterThan(ProcessRegistry.pendingOutputLimit)
        expect(completed).toMatchObject({ running: false, exitCode: 0, truncated: true })
        expect(keptFirstBytes(completed.stdout)).toBe(ProcessRegistry.pendingOutputLimit)
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("flushes one UTF-8 scalar split across byte chunks", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const counter = instrumentByteLength()
        yield* Effect.addFinalizer(() => Effect.sync(() => counter.restore()))
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("emoji", [], "/workspace")
        const process = spawner.spawned[0]!
        const encoded = new TextEncoder().encode("🙂")
        for (const byte of encoded) {
          yield* Queue.offer(process.stdoutQueue, Uint8Array.of(byte))
        }
        yield* Effect.yieldNow
        yield* finish(process)
        const completed = yield* registry.poll(processId, 5_000, 100)
        expect(completed.stdout).toBe("🙂")
        expect(completed.stdout).not.toContain("�")
        expect(counter.total()).toBeLessThanOrEqual(encoded.byteLength)
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("counts only new chunk bytes during bounded collection", () => {
    return Effect.scoped(
      Effect.gen(function* () {
        const counter = instrumentByteLength()
        yield* Effect.addFinalizer(() => Effect.sync(() => counter.restore()))
        const chunk = "x".repeat(200)
        const stream = Stream.fromIterable(Array.from({ length: chunks }, () => new TextEncoder().encode(chunk)))
        const sourceBytes = chunks * new TextEncoder().encode(chunk).byteLength
        const result = yield* ProcessRegistry.collectBoundedText(stream, ProcessRegistry.pendingOutputLimit)
        expect(result.truncated).toBe(false)
        expect(result.text).toBe(chunk.repeat(chunks))
        const longest = counter.inputs.reduce((max, input) => Math.max(max, input.length), 0)
        expect(longest).toBeLessThanOrEqual(chunk.length + 16)
        expect(counter.total()).toBeLessThan(2 * sourceBytes)
      }),
    )
  })

  it.effect("shares one retained byte budget across stdout and stderr", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("command", [], "/workspace")
        const process = spawner.spawned[0]!
        const channelText = "あ".repeat(20_000)
        yield* Queue.offer(process.stdoutQueue, bytes(channelText))
        yield* Queue.offer(process.stderrQueue, bytes(channelText))
        yield* Effect.yieldNow
        yield* finish(process)
        const completed = yield* registry.poll(processId, 5_000, 1_000_000)
        expect(completed).toMatchObject({ running: false, exitCode: 0, truncated: true })
        expect(completed.stderr).toBe("")
        const retained = keptFirstBytes(completed.stdout)
        expect(retained).toBeLessThanOrEqual(ProcessRegistry.pendingOutputLimit)
        expect(retained).toBe(ProcessRegistry.pendingOutputLimit)
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("keeps poll output semantics after incremental accounting", () => {
    const spawner = controlledSpawner([])
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProcessRegistry.Service
        const processId = yield* registry.start("command", [], "/workspace")
        const process = spawner.spawned[0]!
        yield* Queue.offer(process.stdoutQueue, bytes("hello"))
        yield* Effect.yieldNow
        const running = yield* registry.poll(processId, 0, 100)
        const drained = yield* registry.poll(processId, 0, 100)
        expect(running).toMatchObject({ stdout: "hello", stderr: "", running: true, truncated: false })
        expect(drained).toMatchObject({ stdout: "", stderr: "", running: true, truncated: false })
        yield* Queue.offer(process.stdoutQueue, bytes("あ".repeat(10_000)))
        yield* Effect.yieldNow
        const bounded = yield* registry.poll(processId, 0, 1_000)
        expect(bounded.truncated).toBe(true)
        expect(bounded.stdout).toContain("kept first")
        expect(new TextEncoder().encode(bounded.stdout).byteLength).toBe(1_000)
        yield* finish(process, 3)
        const completed = yield* registry.poll(processId, 5_000, 100_000)
        const repeated = yield* registry.poll(processId, 0, 100_000)
        expect(completed).toMatchObject({ running: false, exitCode: 3 })
        expect(repeated).toEqual(completed)
      }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
    )
  })

  it.effect("keeps process finalization scoped after the accumulator rewrite", () => {
    const kills: Array<string> = []
    const spawner = controlledSpawner(kills)
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const finishedId = yield* registry.start("finished", [], "/workspace")
          const finished = spawner.spawned[0]!
          const chunk = "日本語"
          for (let index = 0; index < 10_000; index += 1) {
            yield* Queue.offer(finished.stdoutQueue, bytes(chunk))
          }
          yield* Effect.yieldNow
          yield* finish(finished)
          const terminal = yield* registry.poll(finishedId, 5_000, 1_000_000)
          expect(terminal).toMatchObject({ running: false, exitCode: 0, truncated: true })
          expect(keptFirstBytes(terminal.stdout)).toBe(ProcessRegistry.pendingOutputLimit)
          yield* registry.start("live-one", [], "/workspace")
          yield* registry.start("live-two", [], "/workspace")
        }).pipe(provide(ProcessRegistry.layer.pipe(Layer.provide(spawner.layer)))),
      )
      expect(kills).toEqual(["SIGTERM", "SIGTERM"])
    })
  })
})
