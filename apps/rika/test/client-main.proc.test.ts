import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Path, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

test("plain rika starts only sibling hosted TUI-controller and local-executor roles", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-process-" })
      const roleLog = path.join(root, "roles.log")
      const fixture = fileURLToPath(new URL("fixtures/hosted-role.sh", import.meta.url))
      const client = fileURLToPath(new URL("../src/client-main.ts", import.meta.url))
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [client, "hello"], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            HOME: root,
            RIKA_TEST_RUNTIME_EXECUTABLE: fixture,
            RIKA_TEST_ROLE_LOG: roleLog,
          },
          extendEnv: true,
        }),
      )
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
        ],
        { concurrency: 3 },
      )
      expect(Number(exitCode), `${stdout}\n${stderr}`).toBe(0)
      /**
       * The executor's TERM trap appends its stopped marker as the client exits, so the log can
       * lack it the instant the exit code resolves. Poll briefly; a genuinely unstopped executor
       * still fails the assertions below with the log contents as evidence.
       */
      let roles: ReadonlyArray<string> = []
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const text = yield* fileSystem.readFileString(roleLog).pipe(Effect.orElseSucceed(() => ""))
          roles = text.trim().split("\n")
          if (roles.includes("local-executor-stopped")) return
          yield* Effect.sleep("50 millis")
        }
      })
      expect(roles).toContain("tui-controller|hello")
      expect(roles).toContain(`local-executor|--no-tui --workspace ${process.cwd()}`)
      expect(roles).toContain("local-executor-stopped")
      const files = yield* Effect.promise(() =>
        Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })),
      )
      expect(files.some((file) => /(?:^|\/)(?:rika\.db|.*\.sqlite|server\.json|.*\.sock)$/u.test(file))).toBe(false)
    }),
  ))
