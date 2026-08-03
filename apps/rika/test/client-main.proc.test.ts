import { expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { Database as NativeDatabase } from "bun:sqlite"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { Effect, Fiber, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  interactiveRuntimeRestartLimit,
  interactiveRuntimeRestartPlan,
} from "../src/client/interactive-runtime-restart"
import { interactivePty } from "./client-pty-scenario"
import { run } from "./client-process-test-runtime"
import { makeTuiAppRepositoryLayers, seedHistoricalTranscript } from "./tui-app-repositories"

const legacyRouteModel = (model: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot) => {
  const { providerConnection, registrationIdentity, ...snapshot } = model
  return {
    ...snapshot,
    provider: providerConnection.provider,
    registrationKey: registrationIdentity,
    providerProtocol: providerConnection.protocol,
    providerBaseUrl: providerConnection.baseUrl,
    ...(providerConnection.apiKeyEnvironment === undefined
      ? {}
      : { providerApiKeyEnv: providerConnection.apiKeyEnvironment }),
  }
}

const legacyExecutionRoute = () => {
  const route = ExecutionRouteSnapshot.testExecutionRoute()
  const { version: _version, ...snapshot } = route
  return {
    ...snapshot,
    main: legacyRouteModel(route.main),
    oracle: legacyRouteModel(route.oracle),
    ...(route.title === undefined ? {} : { title: legacyRouteModel(route.title) }),
    ...(route.compactionSummary === undefined ? {} : { compactionSummary: legacyRouteModel(route.compactionSummary) }),
    ...(route.agents === undefined
      ? {}
      : {
          agents: Object.fromEntries(
            Object.entries(route.agents).map(([role, model]) => [role, legacyRouteModel(model)]),
          ),
        }),
  }
}

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
    message: "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
  })
  expect(interactiveRuntimeRestartPlan({ exitCode: 75, restart: { _tag: "restart" }, attempt: 3, limit: 3 })).toEqual({
    _tag: "fail",
    message: "Rika could not finish upgrading. Reinstall Rika, then run it again.",
  })
  expect(interactiveRuntimeRestartPlan({ exitCode: 2, restart: undefined, attempt: 0, limit: 3 })).toEqual({
    _tag: "fail",
    message: "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
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
        RIKA_EXECUTION_DATABASE: `${root}/execution.db`,
        RIKA_TEST_RUNTIME_EXECUTABLE: stub,
        RIKA_TEST_STUB_STATE: state,
        RIKA_TEST_STUB_MODE: mode,
      },
    }),
  )
  const stdout = yield* Effect.forkScoped(
    Stream.runFold(
      handle.stdout.pipe(Stream.decodeText()),
      () => "",
      (text, chunk) => text + chunk,
    ),
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
  return { exitCode, runs, output: `${yield* Fiber.join(stdout)}${yield* Fiber.join(stderr)}` }
})

test(
  "parent respawns the runtime once after a restart signal and passes the thread through",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* stubbedInteractive("restart-once")
        expect(result.exitCode, result.output).toBe(0)
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
        expect(result.output).toContain("Rika could not finish upgrading. Reinstall Rika, then run it again.")
        expect(result.output).not.toContain("process.failed")
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
        expect(result.output).toContain(
          "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
        )
        expect(result.output).not.toContain("exited with code")
        expect(result.output).not.toContain("process.failed")
        expect(result.output).not.toContain("rika.process.role")
      }),
    ),
  30_000,
)

test(
  "continues a migrated 0.1.7 thread on the isolated execution schema",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-migrated-thread-" })
          const home = `${root}/home`
          const dataRoot = `${home}/.rika`
          const workspace = `${root}/workspace`
          const productDatabase = `${dataRoot}/rika.db`
          const legacyExecutionDatabase = `${dataRoot}/execution.db`
          const threadId = "d601e143-0699-41f2-ae80-e03d4979eaa9"
          yield* fs.makeDirectory(dataRoot, { recursive: true })
          yield* fs.makeDirectory(workspace)
          const { repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer } =
            makeTuiAppRepositoryLayers(productDatabase)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const repositories = yield* Layer.buildWithScope(
                Layer.mergeAll(repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer),
                yield* Effect.scope,
              )
              yield* seedHistoricalTranscript(
                { threadId, entryCount: 401, marker: "migrated history marker" },
                workspace,
              ).pipe(Effect.provide(repositories))
            }),
          )
          const legacyRoute = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(legacyExecutionRoute())
          yield* Effect.sync(() => {
            const database = new NativeDatabase(productDatabase)
            database
              .query("UPDATE rika_turns SET execution_route_json = ? WHERE thread_id = ?")
              .run(legacyRoute, threadId)
            database.query("DELETE FROM rika_migrations WHERE migration_id = 28").run()
            database.close()
            const legacy = new NativeDatabase(legacyExecutionDatabase)
            legacy.exec(`
              CREATE TABLE relay_migrations (
                migration_id INTEGER PRIMARY KEY NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                name TEXT NOT NULL
              );
              INSERT INTO relay_migrations (migration_id, name) VALUES (1, 'legacy_baseline');
            `)
            legacy.close()
          })
          const legacyBefore = yield* fs.readFile(legacyExecutionDatabase)
          const result = yield* interactivePty(
            [
              {
                after: "Historical transcript complete",
                write: "new migrated turn\r",
                timeoutMs: 30_000,
              },
              {
                after: "MIGRATED_TURN_OK",
                write: "",
                signal: "SIGTERM",
                turnPrompt: "new migrated turn",
                turnStatus: "completed",
                timeoutMs: 90_000,
              },
            ],
            '[{"parts":[{"type":"text","text":"MIGRATED_TURN_OK"}],"usage":{"inputTokens":1000,"outputTokens":5}}]',
            {
              HOME: home,
              RIKA_DATABASE: productDatabase,
              RIKA_EXECUTION_DATABASE: undefined,
            },
            ["threads", "continue", threadId],
            dataRoot,
          )
          expect(result.timedOut, result.output).toBe(false)
          expect(result.actionsCompleted, result.output).toBe(2)
          expect(result.exitCode, result.output).toBe(-15)
          expect(result.output).toContain("MIGRATED_TURN_OK")
          expect(yield* fs.exists(`${dataRoot}/execution-v2.db`)).toBe(true)
          expect(yield* fs.exists(`${dataRoot}/execution-v2-event-history`)).toBe(true)
          expect([...(yield* fs.readFile(legacyExecutionDatabase))]).toEqual([...legacyBefore])
          const migratedRoute = yield* Effect.sync(() => {
            const database = new NativeDatabase(productDatabase, { readonly: true })
            expect(
              database.query("SELECT migration_id, name FROM rika_migrations ORDER BY migration_id DESC LIMIT 1").get(),
            ).toEqual({ migration_id: 28, name: "product_route_snapshot" })
            expect(
              database
                .query(
                  "SELECT status FROM rika_turns WHERE prompt = 'new migrated turn' ORDER BY created_at DESC LIMIT 1",
                )
                .get(),
            ).toEqual({ status: "completed" })
            const route = String(
              database
                .query("SELECT execution_route_json FROM rika_turns WHERE thread_id = ? ORDER BY created_at LIMIT 1")
                .get(threadId)?.execution_route_json,
            )
            database.close()
            return route
          })
          expect(yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(migratedRoute)).toMatchObject({
            version: 1,
          })
        }),
      ),
    ),
  180_000,
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
