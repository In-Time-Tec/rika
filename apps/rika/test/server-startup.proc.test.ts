import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { reapServers } from "./client-process-test-runtime"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

const snapshotDatabase = (databasePath: string) => {
  const database = new NativeDatabase(databasePath, { readonly: true })
  try {
    return {
      identity: {
        applicationId: database.query("PRAGMA application_id").get(),
        userVersion: database.query("PRAGMA user_version").get(),
      },
      schema: database.query("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name").all(),
      oldSessions: database.query("SELECT id FROM old_sessions ORDER BY id").all(),
    }
  } finally {
    database.close()
  }
}

test(
  "reports an incompatible product database through server startup without polling",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-startup-database-" })
          yield* Effect.addFinalizer(() => Effect.ignore(reapServers(root)))
          const databasePath = `${root}/rika.db`
          yield* Effect.sync(() => {
            const database = new NativeDatabase(databasePath)
            database.exec("CREATE TABLE old_sessions (id TEXT PRIMARY KEY)")
            database.exec("INSERT INTO old_sessions (id) VALUES ('preserve')")
            database.close()
          })
          const before = yield* Effect.sync(() => snapshotDatabase(databasePath))
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
              duration: "120 seconds",
              orElse: () =>
                handle
                  .kill({ killSignal: "SIGKILL" })
                  .pipe(Effect.ignore, Effect.andThen(Effect.fail("server startup never exited"))),
            }),
          )
          expect(Number(exitCode)).not.toBe(0)
          expect(`${stdout}\n${stderr}`).toContain("Use a fresh Rika data root")
          expect(yield* Effect.sync(() => snapshotDatabase(databasePath))).toEqual(before)
          expect((yield* fs.readDirectory(root)).some((name) => name.endsWith(".startup"))).toBe(false)
        }),
      ),
    ),
  180_000,
)
