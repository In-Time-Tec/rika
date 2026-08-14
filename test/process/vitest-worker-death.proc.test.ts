import { Effect } from "effect"
import { expect, test } from "vitest"

test(
  "a killed worker cannot produce an apparent pass",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const child = Bun.spawn(
          [
            process.execPath,
            "--bun",
            "vitest",
            "run",
            "--config",
            "test/fixtures/vitest-worker-death/vitest.config.ts",
          ],
          { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" },
        )
        const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
          Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
        )
        const output = `${stdout}\n${stderr}`
        expect(exitCode).toBe(1)
        expect(output).toContain(
          'VITEST RUN INCOMPLETE {"reason":"process-exit-before-onTestRunEnd","files":{"expected":2,"collected":1,"completed":0},"tests":{"expected":1,"completed":0}}',
        )
      }),
    ),
  20_000,
)
