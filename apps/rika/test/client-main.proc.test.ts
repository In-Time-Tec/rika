import { expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { Effect, Fiber, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { interactiveRuntimeRestartLimit, interactiveRuntimeRestartPlan } from "../src/client-main"
import { interactivePty, run } from "./client-main-harness"

test("restart plan respawns on exit 75 with a restart message", () => {
  expect(
    interactiveRuntimeRestartPlan({
      exitCode: 75,
      restart: { _tag: "restart", threadId: "t-1" },
      attempt: 0,
      limit: interactiveRuntimeRestartLimit,
    }),
  ).toEqual({
    _tag: "respawn",
    environment: { RIKA_INTERNAL_RUNTIME_RESTARTED: "1", RIKA_INTERNAL_RESTART_THREAD: "t-1" },
  })
  expect(interactiveRuntimeRestartPlan({ exitCode: 75, restart: { _tag: "restart" }, attempt: 1, limit: 3 })).toEqual({
    _tag: "respawn",
    environment: { RIKA_INTERNAL_RUNTIME_RESTARTED: "1" },
  })
})

test("restart plan fails on exit 75 without a message, at the limit, and on other failures", () => {
  expect(interactiveRuntimeRestartPlan({ exitCode: 75, restart: undefined, attempt: 0, limit: 3 })).toEqual({
    _tag: "fail",
    message: "Rika interactive runtime exited with code 75",
  })
  expect(interactiveRuntimeRestartPlan({ exitCode: 75, restart: { _tag: "restart" }, attempt: 3, limit: 3 })._tag).toBe(
    "fail",
  )
  expect(interactiveRuntimeRestartPlan({ exitCode: 2, restart: undefined, attempt: 0, limit: 3 })).toEqual({
    _tag: "fail",
    message: "Rika interactive runtime exited with code 2",
  })
})

test("restart plan completes on clean exits", () => {
  expect(interactiveRuntimeRestartPlan({ exitCode: 0, restart: undefined, attempt: 0, limit: 3 })).toEqual({
    _tag: "done",
  })
  expect(interactiveRuntimeRestartPlan({ exitCode: 130, restart: undefined, attempt: 2, limit: 3 })).toEqual({
    _tag: "done",
  })
})

const stubbedInteractive = Effect.fn("ClientMainTest.stubbedInteractive")(function* (mode: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-runtime-restart-" })
  const directory = fileURLToPath(new URL(".", import.meta.url))
  const stub = `${root}/runtime-stub`
  yield* fs.writeFileString(stub, `#!/bin/sh\nexec bun ${directory}fixtures/runtime-stub.ts "$@"\n`)
  yield* fs.chmod(stub, 0o755)
  const state = `${root}/runs.jsonl`
  const handle = yield* spawner.spawn(
    ChildProcess.make("bun", ["src/client-main.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      extendEnv: true,
      env: {
        HOME: root,
        RIKA_DATABASE: `${root}/rika.db`,
        RIKA_RELAY_DATABASE: `${root}/relay.db`,
        RIKA_TEST_RUNTIME_EXECUTABLE: stub,
        RIKA_TEST_STUB_STATE: state,
        RIKA_TEST_STUB_MODE: mode,
      },
    }),
  )
  const stderr = yield* Effect.forkScoped(
    Stream.runFold(
      handle.stderr.pipe(Stream.decodeText()),
      () => "",
      (text, chunk) => text + chunk,
    ),
  )
  const exitCode = Number(yield* handle.exitCode)
  const runs = (yield* fs.readFileString(state))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { restarted: string; thread: string })
  return { exitCode, runs, stderr: yield* Fiber.join(stderr) }
})

test(
  "parent respawns the runtime once after a restart signal and passes the thread through",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* stubbedInteractive("restart-once")
        expect(result.exitCode, result.stderr).toBe(0)
        expect(result.runs).toEqual([
          { restarted: "", thread: "" },
          { restarted: "1", thread: "t-1" },
        ])
      }),
    ),
  30_000,
)

test(
  "parent stops respawning at the restart limit",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* stubbedInteractive("always-restart")
        expect(result.exitCode).toBe(2)
        expect(result.runs.length).toBe(interactiveRuntimeRestartLimit + 1)
        expect(result.stderr).toContain(`restarted ${interactiveRuntimeRestartLimit} times`)
      }),
    ),
  30_000,
)

test(
  "parent treats exit 75 without a restart message as a failure",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* stubbedInteractive("silent-75")
        expect(result.exitCode).toBe(2)
        expect(result.runs.length).toBe(1)
        expect(result.stderr).toContain("exited with code 75")
      }),
    ),
  30_000,
)

test(
  "exits cleanly when Ctrl+C quits the idle interactive TUI",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* interactivePty([{ after: "Welcome to Rika", write: "\u0003" }])
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted).toBe(1)
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).toContain(".#*+:")
        expect(result.output).not.toContain("Rika interactive runtime exited with code")
        expect(result.clientLogs).not.toContain('"message":"process.failed"')
        expect(result.names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
      }),
    ),
  45_000,
)
