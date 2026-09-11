/* oxlint-disable effecttsgo/strict-effect-provide -- this process fixture deliberately builds an isolated scoped registry. */

import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { expect, test } from "vitest"

// ast-grep-ignore: effect-prefer-filesystem
import { existsSync, readFileSync } from "node:fs" // oxlint-disable-line effecttsgo/node-builtin-import
import * as ProcessRegistry from "../src/native/process-registry"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

test("interrupting a real bash descendant cancels the process group before side effects continue", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-process-" })
      const marker = `${checkout}/marker.txt`
      yield* fileSystem.writeFileString(
        `${checkout}/child.sh`,
        `trap 'exit 0' TERM\nprintf 'retained output\\n'\nprintf 'retained error\\n' >&2\nprintf started > marker.txt\nsleep 60 &\necho $! > grandchild.pid\necho $$ > child.pid\nwait\nprintf done > marker.txt\n`,
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* ProcessRegistry.Service
          const running = yield* registry.start("/bin/sh", ["-c", "trap 'exit 0' TERM; sh child.sh & wait"], checkout)
          yield* Effect.tryPromise(() =>
            expect.poll(() => existsSync(`${checkout}/grandchild.pid`), { timeout: 1_000 }).toBe(true),
          )
          const child = Number(readFileSync(`${checkout}/child.pid`, "utf8"))
          const grandchild = Number(readFileSync(`${checkout}/grandchild.pid`, "utf8"))
          const alive = (pid: number) =>
            spawner.string(ChildProcess.make("ps", ["-o", "stat=", "-p", String(pid)])).pipe(
              Effect.map((state) => state.trim() !== ""),
              Effect.orElseSucceed(() => false),
            )
          expect(yield* alive(child)).toBe(true)
          expect(yield* alive(grandchild)).toBe(true)
          expect(readFileSync(`${checkout}/child.pid`, "utf8").trim()).toBeTruthy()
          yield* registry.cancel(running)
          expect(yield* alive(child)).toBe(false)
          expect(yield* alive(grandchild)).toBe(false)
          const terminal = yield* registry.observe(running)
          expect(terminal.exitCode).toBeTypeOf("number")
          expect(yield* Effect.result(registry.cancel(running))).toMatchObject({ _tag: "Success" })
          const output = yield* registry.poll(running, 0, 1024)
          expect(output).toMatchObject({
            processId: running,
            running: false,
            stdout: "retained output\n",
            stderr: "retained error\n",
            exitCode: terminal.exitCode,
            truncated: false,
          })
          yield* registry.cancel(running)
          expect(yield* registry.observe(running)).toEqual(terminal)
          expect(yield* registry.poll(running, 0, 1024)).toEqual(output)
          yield* Effect.sleep("150 millis")
          expect(readFileSync(marker, "utf8")).toBe("started")
        }).pipe(Effect.provide(ProcessRegistry.layer.pipe(Layer.provide(BunServices.layer)))),
      )
    }),
  ).pipe(Effect.runPromise))
