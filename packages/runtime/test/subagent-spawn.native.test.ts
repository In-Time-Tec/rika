import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"

test("model spawns a durable Oracle child through the handoff tool and resumes with its result", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-" })
      const fixture = yield* TestModel.make([
        TestModel.toolCall("transfer_to_oracle", {}, { id: "call-oracle" }),
        TestModel.turn([
          ...Array.from({ length: 1_100 }, () => TestModel.text(".")),
          TestModel.text("Oracle investigated the boundary."),
        ]),
        TestModel.object({ answer: "Oracle investigated the boundary.", evidence: [] }),
        TestModel.text("Parent synthesized the child answer."),
      ])
      const runtimeLayer = Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false }))
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: runtimeLayer,
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
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
          startedAt: 1,
        })
        const settled = yield* backend.replay("turn-subagent").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
          }),
        )
        const inspection = yield* backend.inspect("turn-subagent")
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const childExecutionId = inspection?.children[0]?.executionId
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
          expect(requested.some((event) => event.data?.tool_name === "transfer_to_oracle")).toBe(true)
          expect(settledTypes).toContain("child_run.spawned")
          expect(settled.status).toBe("completed")
          expect(inspection?.children).toHaveLength(1)
          expect(child?.status).toBe("completed")
          expect(child?.session_id).toBe(`session:child:${child?.id}`)
          expect(childFailure).toBeNull()
          expect(childEventCount).toBeGreaterThan(1_000)
          expect(inspection?.children[0]?.status).toBe("completed")
          expect(
            settled.events
              .filter((event) => event.type === "model.output.delta")
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
      const fixture = yield* TestModel.make([
        TestModel.toolCall("transfer_to_review", {}, { id: "call-review" }),
        TestModel.turn([TestModel.toolCall("read_file", { path: "AGENTS.md" }, { id: "call-child-read" })]),
        TestModel.object({ summary: "Workspace inspected.", findings: [] }),
        TestModel.text("Parent received the review."),
      ])
      const workspaces = new Map([["turn-review", workspace]])
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayerForWorkspace: Runtime.layer,
        resolveWorkspace: (executionId) => {
          const turnId = RelayExecutionBackend.turnIdFromExecutionId(executionId)
          const resolved = turnId === undefined ? undefined : workspaces.get(turnId)
          return resolved === undefined
            ? Effect.fail(
                ExecutionBackend.BackendError.make({
                  message: turnId === undefined ? `Unknown execution ${executionId}` : `Turn ${turnId} does not exist`,
                }),
              )
            : Effect.succeed(resolved)
        },
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-review",
          turnId: "turn-review",
          prompt: "Ask Review to inspect AGENTS.md.",
          startedAt: 1,
        })
        const settled = yield* backend.replay("turn-review").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
          }),
        )
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
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

test("handoff child approval asks surface through the parent and resume after approval", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-permission-" })
      yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "permission marker")
      const fixture = yield* TestModel.make([
        TestModel.toolCall("transfer_to_review", {}, { id: "call-parent-review" }),
        TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "call-child-permission" }),
        TestModel.text("Child read the fixture."),
        TestModel.object({ summary: "Fixture read.", findings: [] }),
        TestModel.text("Parent received the approved child result."),
      ])
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.layer(directory),
        toolNeedsApproval: (name) => name === "read_file",
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const input = {
          threadId: "thread-child-permission",
          turnId: "turn-child-permission",
          prompt: "Ask Review to read fixture.txt.",
          startedAt: 1,
        }
        const waiting = yield* start(backend, input)
        const ask = waiting.events.find((event) => event.type === "tool.approval.requested")
        const waitId = ask?.data?.wait_id
        if (typeof waitId !== "string") return yield* Effect.die("Missing child permission wait")
        const approvals = yield* backend.listApprovals(input.turnId)
        yield* backend.resolveToolApproval(waitId, true, 2, "test approval")
        const completed = yield* start(backend, input)
        return { waiting, ask, approvals, completed, requests: yield* fixture.requests }
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
      Effect.tap(({ waiting, ask, approvals, completed, requests }) =>
        Effect.sync(() => {
          expect(waiting.status).toBe("waiting")
          expect(String(ask?.data?.execution_id)).toStartWith("execution:turn-child-permission:child:")
          expect(approvals[0]?.executionId).toBe(String(ask?.data?.execution_id))
          expect(completed.status).toBe("completed")
          expect(requests.length).toBeGreaterThanOrEqual(5)
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
      const fixture = yield* TestModel.make([
        TestModel.toolCall("transfer_to_review", {}, { id: "call_shared" }),
        TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "call_shared" }),
        TestModel.text("Child reused the call id."),
        TestModel.object({ summary: "Call id reused.", findings: [] }),
        TestModel.text("Parent received the child result."),
      ])
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.layer(directory),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
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
          startedAt: 1,
        })
        const inspection = yield* backend.inspect("turn-shared-call-id")
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
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
          expect(calls).toHaveLength(2)
          expect(new Set(calls.map((call) => call.id)).size).toBe(2)
          for (const call of calls) {
            expect(call.id).toBe(`rika:${encodeURIComponent(call.execution_id)}:call_shared`)
          }
        }),
      ),
    ),
  )
}, 60_000)
