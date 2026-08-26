import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const Counts = Schema.Struct({
  files: Schema.Struct({ expected: Schema.Finite, completed: Schema.Finite }),
  tests: Schema.Struct({ expected: Schema.Finite, completed: Schema.Finite }),
})

it.layer(BunServices.layer)("worker process completeness", (test) => {
  test.effect("a killed worker cannot produce an apparent pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            ["--bun", "vitest", "run", "--config", "test/fixtures/vitest-worker-death/vitest.config.ts"],
            { cwd: process.cwd() },
          ),
        )
        const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (output, chunk) => output + chunk,
            ),
          )
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [child.exitCode, collect(child.stdout), collect(child.stderr)],
          {
            concurrency: "unbounded",
          },
        )
        const output = `${stdout}\n${stderr}`
        expect(Number(exitCode)).toBe(1)
        const reported = output.split("\n").find((line) => line.startsWith("VITEST RUN "))
        expect(reported).toBeDefined()
        expect(reported).not.toContain("VITEST RUN COMPLETE")
        const counts = yield* Schema.decodeEffect(Schema.fromJsonString(Counts))(
          reported!.slice(reported!.indexOf("{")),
        )
        expect(counts.files.completed).toBeLessThan(counts.files.expected)
        expect(counts.tests.completed).toBeLessThan(counts.tests.expected)
      }),
    ),
  )
})
