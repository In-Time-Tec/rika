import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { Clock, Effect, FileSystem, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const pollUntil = <E, R>(probe: Effect.Effect<boolean, E, R>, description: string) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 10_000
    while (!(yield* probe)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return yield* Effect.die(`Timed out waiting for ${description}`)
      yield* Effect.sleep("25 millis")
    }
  })

const decodeLogRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ message: Schema.String })))

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scopedWith((scope) =>
      Layer.buildWithScope(BunServices.layer, scope).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provideContext(context))),
      ),
    ),
  )

test("persists the final buffered record before settling on process.exit", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-hardexit-" })
        const handle = yield* spawner.spawn(
          ChildProcess.make("bun", ["test/fixtures/logging-hardexit.ts"], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            extendEnv: true,
            env: { RIKA_TEST_LOG_DATA_ROOT: dataRoot },
          }),
        )
        const exitCode = yield* handle.exitCode
        expect(Number(exitCode)).toBe(0)
        const diagnostics = `${dataRoot}/diagnostics`
        const names = yield* fs.readDirectory(diagnostics)
        expect(names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
        const [closedName] = names.filter((name) => /^server-.+\.jsonl$/.test(name))
        expect(closedName).toBeDefined()
        expect(yield* fs.readFileString(`${diagnostics}/${closedName}`)).toContain("logging.hardexit.fixture")
      }),
    ),
  ))

test("persists an accepted batch when process.exit interrupts its first ordinary write", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-inflight-hardexit-" })
        const handle = yield* spawner.spawn(
          ChildProcess.make("bun", ["test/fixtures/logging-inflight-hardexit.ts"], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            extendEnv: true,
            env: { RIKA_TEST_LOG_DATA_ROOT: dataRoot },
          }),
        )
        expect(Number(yield* handle.exitCode)).toBe(0)
        expect(yield* fs.exists(`${dataRoot}/write.started`)).toBe(true)
        const diagnostics = `${dataRoot}/diagnostics`
        const names = yield* fs.readDirectory(diagnostics)
        expect(names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
        const [closedName] = names.filter((name) => /^server-.+\.jsonl$/.test(name))
        expect(closedName).toBeDefined()
        const contents = (yield* fs.readFileString(`${diagnostics}/${closedName}`)).trim()
        const messages = contents.split("\n").map((line) => decodeLogRecord(line).message)
        expect(messages).toEqual(["logging.inflight.first", "logging.inflight.second", "logging.inflight.third"])
        expect(new Set(messages).size).toBe(messages.length)
      }),
    ),
  ))

test("renames the open diagnostics log before another beforeExit listener tears down the runtime", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-beforeexit-" })
        const handle = yield* spawner.spawn(
          ChildProcess.make("bun", ["test/fixtures/logging-beforeexit.ts"], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            extendEnv: true,
            env: { RIKA_TEST_LOG_DATA_ROOT: dataRoot },
          }),
        )
        const exitCode = yield* handle.exitCode
        expect(Number(exitCode)).toBe(0)
        const diagnostics = `${dataRoot}/diagnostics`
        const names = yield* fs.readDirectory(diagnostics)
        expect(names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
        expect(names.filter((name) => /^client-.+\.jsonl$/.test(name))).toHaveLength(1)
      }),
    ),
  ))

test("flushes and closes diagnostics when signaled after the first-draw boundary", () => {
  const secret = "must-not-cross-the-diagnostics-boundary"
  return run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-signal-" })
        const handle = yield* spawner.spawn(
          ChildProcess.make("bun", ["test/fixtures/logging-signal-exit.ts"], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "inherit",
            extendEnv: true,
            env: { RIKA_TEST_LOG_DATA_ROOT: dataRoot, RIKA_TEST_ARBITRARY_VALUE: secret },
          }),
        )
        yield* pollUntil(fs.exists(`${dataRoot}/first-draw.boundary`), "first draw boundary")
        expect(yield* fs.exists(`${dataRoot}/diagnostics`)).toBe(false)
        yield* fs.writeFileString(`${dataRoot}/logging.release`, "release")
        yield* pollUntil(fs.exists(`${dataRoot}/logging.ready`), "diagnostics readiness")
        yield* handle.kill({ killSignal: "SIGTERM" })
        expect(Number(yield* handle.exitCode)).toBe(130)
        const diagnostics = `${dataRoot}/diagnostics`
        const names = yield* fs.readDirectory(diagnostics)
        expect(names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
        const [closedName] = names.filter((name) => /^client-.+\.jsonl$/.test(name))
        expect(closedName).toBeDefined()
        const contents = yield* fs.readFileString(`${diagnostics}/${closedName}`)
        expect(contents).toContain("logging.signal.fixture")
        expect(contents).not.toContain(secret)
      }),
    ),
  )
})
