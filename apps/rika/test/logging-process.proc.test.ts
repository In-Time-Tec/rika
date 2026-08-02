import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scopedWith((scope) =>
      Layer.buildWithScope(BunServices.layer, scope).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provideContext(context))),
      ),
    ),
  )

test("renames the open diagnostics log on a process.exit that bypasses the scope finalizer", () =>
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
        expect(names.filter((name) => /^resident-.+\.jsonl$/.test(name))).toHaveLength(1)
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
