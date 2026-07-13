import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"

test("model spawns a durable Oracle child through the handoff tool and resumes with its result", async () => {
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
        toolRuntimeLayer: runtimeLayer,
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
        compaction: {
          contextWindow: 1_000_000,
          reserveTokens: 100,
          keepRecentTokens: 100,
        },
      })
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* backend.start({
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
        const database = new Database(`${directory}/relay.db`, { readonly: true })
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
        database.close()
        return { started, settled, inspection, child, childFailure, childEventCount }
      }).pipe(Effect.provide(backendLayer))
    }),
  ).pipe(Effect.provide(BunServices.layer))
  const { started, settled, inspection, child, childFailure, childEventCount } = await Effect.runPromise(program)
  const settledTypes = settled.events.map((event) => event.type)
  const requested = settled.events.filter((event) => event.type === "tool.call.requested")
  expect(started.status).not.toBe("failed")
  expect(requested.some((event) => (event.data?.tool_name as string | undefined) === "transfer_to_oracle")).toBe(true)
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
}, 60_000)
