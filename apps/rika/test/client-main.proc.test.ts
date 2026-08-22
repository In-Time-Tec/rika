import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Path, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

test("plain rika starts only sibling hosted TUI-controller and runner-executor roles", () =>
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
            RIKA_TEST_RUNNER_EXECUTOR_STDOUT: "1",
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
      expect(stdout).toBe("")
      /**
       * The executor's TERM trap appends its stopped marker as the client exits, so the log can
       * lack it the instant the exit code resolves. Poll briefly; a genuinely unstopped executor
       * still fails the assertions below with the log contents as evidence.
       */
      let roles: ReadonlyArray<string> = []
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const text = yield* fileSystem.readFileString(roleLog).pipe(Effect.orElseSucceed(() => ""))
        roles = text.trim().split("\n")
        if (roles.includes("runner-executor-stopped")) break
        yield* Effect.sleep("50 millis")
      }
      expect(roles).toContain("tui-controller|hello")
      expect(roles).toContain(`runner-executor|--no-tui --workspace ${process.cwd()}`)
      expect(roles).toContain("runner-executor-stopped")
      const files = yield* Effect.promise(() =>
        Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })),
      )
      expect(files.some((file) => /(?:^|\/)(?:rika\.db|.*\.sqlite|server\.json|.*\.sock)$/u.test(file))).toBe(false)
    }),
  ))

test("the hosted TUI controller returns one unformatted error for its parent process", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-controller-failure-" })
      const workspace = path.join(root, "missing")
      const client = fileURLToPath(new URL("../src/client-main.ts", import.meta.url))
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [client, "--workspace", workspace], {
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: root, RIKA_INTERNAL_CLIENT_RUNTIME: "1" },
          extendEnv: true,
        }),
      )
      const [exitCode, stderr] = yield* Effect.all([child.exitCode, Stream.mkString(Stream.decodeText(child.stderr))], {
        concurrency: 2,
      })
      expect(Number(exitCode)).not.toBe(0)
      expect(stderr.trim()).toBe(`Workspace is not a directory: ${workspace}`)
    }),
  ))

test("plain rika exposes a hosted controller failure and does not fall back to local authority", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-failure-" })
      const roleLog = path.join(root, "roles.log")
      const fixture = fileURLToPath(new URL("fixtures/hosted-role.sh", import.meta.url))
      const client = fileURLToPath(new URL("../src/client-main.ts", import.meta.url))
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [client], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            HOME: root,
            RIKA_TEST_RUNTIME_EXECUTABLE: fixture,
            RIKA_TEST_ROLE_LOG: roleLog,
            RIKA_TEST_TUI_FAILURE: "1",
            RIKA_TEST_RUNNER_EXECUTOR_FAILURE: "1",
          },
          extendEnv: true,
        }),
      )
      const [exitCode, stderr] = yield* Effect.all([child.exitCode, Stream.mkString(Stream.decodeText(child.stderr))], {
        concurrency: 2,
      })
      expect(Number(exitCode)).not.toBe(0)
      expect(stderr.trim()).toBe("Run rika auth login first")
      expect((yield* fileSystem.readFileString(roleLog)).trim().split("\n").toSorted()).toEqual(
        [`runner-executor|--no-tui --workspace ${process.cwd()}`, "tui-controller|"].toSorted(),
      )
      const files = yield* Effect.promise(() =>
        Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })),
      )
      expect(files.some((file) => /(?:^|\/)(?:rika\.db|.*\.sqlite|server\.json|.*\.sock)$/u.test(file))).toBe(false)
    }),
  ))
