import * as BunServices from "@effect/platform-bun/BunServices"

import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"
import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schedule } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import { layer } from "../src/relay/execution/relay-execution-layer"
import { turnIdFromExecutionId } from "../src/relay/execution/relay-execution-identifier"
import { routedModel } from "./routed-model"
import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-spawn-fixture"
const { terminal, testModelRegistration } = testSupport
test("model spawns a durable Oracle child through the handoff tool and resumes with its result", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-" })
      const fixture = yield* routedModel({
        lanes: [
          {
            steps: [
              TestModel.toolCall("oracle", { prompt: "Investigate the boundary." }, { id: "call-oracle" }),
              TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
              TestModel.text("Parent synthesized the child answer."),
            ],
          },
          {
            when: (prompt) => !prompt.includes("Ask the Oracle to investigate the boundary."),
            steps: [
              TestModel.turn([
                ...Array.from({ length: 1_100 }, () => TestModel.text(".")),
                TestModel.text("Oracle investigated the boundary."),
              ]),
            ],
          },
        ],
      })
      const runtimeLayer = Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false }))
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: testModelRegistration(fixture.registration),
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: runtimeLayer,
        compaction: {
          contextWindow: 1_000_000,
          reserveTokens: 100,
          keepRecentTokens: 100,
        },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-subagent",
          turnId: "turn-subagent",
          prompt: "Ask the Oracle to investigate the boundary.",
        })
        const settled = yield* backend.replay("turn-subagent").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.spaced("20 millis"),
          }),
        )
        const inspection = yield* backend.inspect("turn-subagent")
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const childExecutionId = `child:${encodeURIComponent("execution:turn-subagent")}:call-oracle`
        const child = database
          .query<
            { readonly id: string; readonly session_id: string | null; readonly status: string },
            [string]
          >("select id, session_id, status from relay_executions where id = ?")
          .get(childExecutionId ?? "")
        const childFailure =
          child === null
            ? null
            : database
                .query<
                  { readonly data_json: string },
                  [string]
                >("select data_json from relay_execution_events where execution_id = ? and type = 'execution.failed'")
                .get(child.id)
        const childEventCount =
          child === null
            ? 0
            : (database
                .query<
                  { readonly count: number },
                  [string]
                >("select count(*) as count from relay_execution_events where execution_id = ?")
                .get(child.id)?.count ?? 0)
        return { started, settled, inspection, child, childFailure, childEventCount }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ started, settled, inspection, child, childFailure, childEventCount }) =>
        Effect.sync(() => {
          const settledTypes = settled.events.map((event) => event.type)
          const requested = settled.events.filter((event) => event.type === "tool.call.requested")
          expect(started.status).not.toBe("failed")
          expect(requested.some((event) => event.data?.tool_name === "oracle")).toBe(true)
          expect(childFailure).toBeNull()
          expect(settledTypes).toContain("child_run.spawned")
          expect(settled.status).toBe("completed")
          expect(inspection?.children).toHaveLength(1)
          expect(child?.status).toBe("completed")
          expect(child?.session_id).toBe(`session:child:${child?.id}`)
          expect(childEventCount).toBeGreaterThan(0)
          expect(childEventCount).toBeLessThan(200)
          expect(inspection?.children[0]?.status).toBe("completed")
          expect(
            settled.events
              .filter((event) => event.type === "model.cycle.completed")
              .map((event) => event.text)
              .join(""),
          ).toBe("Parent synthesized the child answer.")
        }),
      ),
    ),
  )
}, 60_000)
test("handoff children resolve real workspace tools through their parent Rika turn", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-workspace-" })
      const workspace = `${directory}/workspace`
      yield* fileSystem.makeDirectory(workspace)
      yield* fileSystem.writeFileString(`${workspace}/AGENTS.md`, "child workspace marker")
      const fixture = yield* routedModel({
        lanes: [
          {
            steps: [
              TestModel.toolCall("review", { prompt: "Inspect AGENTS.md." }, { id: "call-review" }),
              TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
              TestModel.text("Parent received the review."),
            ],
          },
          {
            when: (prompt) => !prompt.includes("Ask Review to inspect AGENTS.md."),
            steps: [
              TestModel.turn([TestModel.toolCall("read", { path: "AGENTS.md" }, { id: "call-child-read" })]),
              TestModel.text("Child inspected the workspace."),
            ],
          },
        ],
      })
      const workspaces = new Map([["turn-review", workspace]])
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: testModelRegistration(fixture.registration),
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayerForWorkspace: (runtimeWorkspace) =>
          Runtime.layerWithProcessRegistry(runtimeWorkspace, WorkspaceIndex.layer(runtimeWorkspace)).pipe(
            Layer.catch((error) =>
              Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: String(error) }))),
            ),
          ),
        resolveWorkspace: (executionId) => {
          const turnId = turnIdFromExecutionId(executionId)
          const resolved = turnId === undefined ? undefined : workspaces.get(turnId)
          return resolved === undefined
            ? Effect.fail(
                ExecutionBackend.BackendError.make({
                  message: turnId === undefined ? `Unknown execution ${executionId}` : `Turn ${turnId} does not exist`,
                }),
              )
            : Effect.succeed(resolved)
        },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-review",
          turnId: "turn-review",
          prompt: "Ask Review to inspect AGENTS.md.",
        })
        const settled = yield* backend.replay("turn-review").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.spaced("20 millis"),
          }),
        )
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const toolResult = database
          .query<
            { readonly output_json: string; readonly error: string | null },
            [string]
          >("select output_json, error from relay_tool_results where output_json like ?")
          .get("%child workspace marker%")
        return { started, settled, toolResult }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ started, settled, toolResult }) =>
        Effect.sync(() => {
          expect(started.status).toBe("completed")
          expect(settled.status).toBe("completed")
          expect(toolResult?.error).toBeNull()
          expect(toolResult?.output_json).toContain("child workspace marker")
        }),
      ),
    ),
  )
}, 60_000)
test("parent and handoff child may reuse a model tool-call identifier", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-call-id-" })
      yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "shared call id marker")
      const fixture = yield* routedModel({
        lanes: [
          {
            steps: [
              TestModel.toolCall("review", { prompt: "Read fixture.txt." }, { id: "call_shared" }),
              TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
              TestModel.text("Parent received the child result."),
            ],
          },
          {
            when: (prompt) => !prompt.includes("Ask Review to read fixture.txt."),
            steps: [
              TestModel.toolCall("read", { path: "fixture.txt" }, { id: "call_shared" }),
              TestModel.text("Child reused the call id."),
            ],
          },
        ],
      })
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: testModelRegistration(fixture.registration),
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.layer(directory).pipe(
          Layer.catch((error) =>
            Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: String(error) }))),
          ),
        ),
        compaction: {
          contextWindow: 1_000_000,
          reserveTokens: 100,
          keepRecentTokens: 100,
        },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const completed = yield* start(backend, {
          threadId: "thread-shared-call-id",
          turnId: "turn-shared-call-id",
          prompt: "Ask Review to read fixture.txt.",
        })
        const inspection = yield* backend.inspect("turn-shared-call-id")
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const readResult = database
          .query<
            { readonly output_json: string; readonly error: string | null },
            [string]
          >("select output_json, error from relay_tool_results where output_json like ?")
          .get("%shared call id marker%")
        const calls = database
          .query<
            { readonly id: string; readonly execution_id: string },
            []
          >("select id, execution_id from relay_tool_calls order by execution_id, id")
          .all()
        return { completed, inspection, readResult, calls }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ completed, inspection, readResult, calls }) =>
        Effect.sync(() => {
          expect(completed.status).toBe("completed")
          expect(inspection?.children[0]?.status).toBe("completed")
          expect(readResult?.error).toBeNull()
          expect(readResult?.output_json).toContain("shared call id marker")
          expect(calls.filter((call) => call.id === "call_shared")).toHaveLength(2)
          expect(new Set(calls.filter((call) => call.id === "call_shared").map((call) => call.execution_id)).size).toBe(
            2,
          )
        }),
      ),
    ),
  )
}, 60_000)
