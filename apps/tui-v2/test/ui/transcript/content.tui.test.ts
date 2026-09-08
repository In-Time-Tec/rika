import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

test("reasoning and answers preserve markdown across fragment sizes and settlement", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        yield* Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make("bun", ["--preload", "@opentui/solid/preload", "test/fixtures/transcript-markdown.ts"], {
              cwd: fileURLToPath(new URL("../../..", import.meta.url)),
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit",
            }),
          )
          expect(Number(yield* child.exitCode)).toBe(0)
        }).pipe(Effect.provide(services))
      }),
    ),
  ))
