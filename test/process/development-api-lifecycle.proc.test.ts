import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Config, Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const running = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

it.live(
  "interrupting the Alchemy wrapper terminates its owned API process",
  () =>
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(
        Effect.flatMap((context) =>
          Effect.provide(
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
              const systemPath = yield* Config.string("PATH")
              const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-development-api-" })
              const bin = path.join(directory, "bin")
              const childPidPath = path.join(directory, "child.pid")
              yield* fileSystem.makeDirectory(bin)
              yield* fileSystem.writeFileString(
                path.join(bin, "bun"),
                `#!/bin/sh
echo $$ > "$RIKA_DEV_CHILD_PID_PATH"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
                { mode: 0o700 },
              )
              const wrapper = yield* Effect.acquireRelease(
                spawner.spawn(
                  ChildProcess.make(process.execPath, ["scripts/development/api.ts"], {
                    cwd: process.cwd(),
                    env: {
                      PATH: `${bin}:${systemPath}`,
                      RIKA_DEV_CHILD_PID_PATH: childPidPath,
                    },
                    extendEnv: true,
                    stdout: "ignore",
                    stderr: "ignore",
                  }),
                ),
                (child) => child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore),
              )
              for (let attempt = 0; attempt < 500 && !(yield* fileSystem.exists(childPidPath)); attempt += 1)
                yield* Effect.sleep("10 millis")
              expect(yield* fileSystem.exists(childPidPath)).toBe(true)
              const childPid = Number((yield* fileSystem.readFileString(childPidPath)).trim())
              expect(yield* running(childPid)).toBe(true)

              yield* wrapper.kill({ forceKillAfter: "2 seconds" })
              yield* wrapper.exitCode
              for (let attempt = 0; attempt < 500 && (yield* running(childPid)); attempt += 1)
                yield* Effect.sleep("10 millis")
              expect(yield* running(childPid)).toBe(false)
            }),
            context,
          ),
        ),
      ),
    ),
  20_000,
)
