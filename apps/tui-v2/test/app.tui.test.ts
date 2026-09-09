import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

test("Ctrl+C opens a capturable exit banner after dismissing the Thread switcher, then quits on repetition", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        yield* Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make("bun", ["--preload", "@opentui/solid/preload", "test/fixtures/overlay-lifecycle.ts"], {
              cwd: fileURLToPath(new URL("..", import.meta.url)),
              stdin: "ignore",
              stdout: "ignore",
              stderr: "inherit",
            }),
          )
          expect(Number(yield* child.exitCode)).toBe(0)
        }).pipe(Effect.provide(services))
      }),
    ),
  ))

test("hosted reconnect banner and keyboard stop/cancel controls render and dispatch", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        yield* Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make("bun", ["--preload", "@opentui/solid/preload", "test/fixtures/hosted-controls.tsx"], {
              cwd: fileURLToPath(new URL("..", import.meta.url)),
              stdin: "ignore",
              stdout: "ignore",
              stderr: "inherit",
            }),
          )
          expect(Number(yield* child.exitCode)).toBe(0)
        }).pipe(Effect.provide(services))
      }),
    ),
  ))
