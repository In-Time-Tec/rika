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
        const reported = output.split("\n").find((line) => line.startsWith("VITEST RUN "))
        expect(reported).toBeDefined()
        expect(reported).not.toContain("VITEST RUN COMPLETE")
        const counts = JSON.parse(reported!.slice(reported!.indexOf("{"))) as {
          readonly files: { readonly expected: number; readonly completed: number }
          readonly tests: { readonly expected: number; readonly completed: number }
        }
        expect(counts.files.completed).toBeLessThan(counts.files.expected)
        expect(counts.tests.completed).toBeLessThan(counts.tests.expected)
      }),
    ),
  20_000,
)
