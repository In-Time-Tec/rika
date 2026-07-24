import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

test(
  "reports an incompatible product database through resident startup without polling",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-database-" })
          const databasePath = `${root}/rika.db`
          const relayPath = `${root}/relay.db`
          yield* Effect.sync(() => {
            const database = new NativeDatabase(databasePath)
            database.exec("CREATE TABLE old_sessions (id TEXT PRIMARY KEY)")
            database.close()
          })
          const before = yield* fs.readFile(databasePath)
          const handle = yield* spawner.spawn(
            ChildProcess.make("bun", ["src/client-main.ts", "doctor"], {
              cwd: fileURLToPath(new URL("..", import.meta.url)),
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              extendEnv: true,
              env: {
                HOME: root,
                RIKA_DATABASE: databasePath,
                RIKA_RELAY_DATABASE: relayPath,
              },
            }),
          )
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: 3 },
          ).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                handle
                  .kill({ killSignal: "SIGKILL" })
                  .pipe(Effect.ignore, Effect.andThen(Effect.fail("resident startup did not fail promptly"))),
            }),
          )
          expect(Number(exitCode)).not.toBe(0)
          expect(`${stdout}\n${stderr}`).toContain("Use a fresh Rika data root")
          expect([...(yield* fs.readFile(databasePath))]).toEqual([...before])
          expect((yield* fs.readDirectory(root)).some((name) => name.endsWith(".startup"))).toBe(false)
        }),
      ),
    ),
  15_000,
)
