import * as BunServices from "@effect/platform-bun/BunServices"
import { ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import { layer } from "../src/relay/execution/relay-execution-layer"
import { routedModel } from "./routed-model"
import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-spawn-fixture"
const { decodeToolExecution, nestedRootPrompt, executionModelRoute } = testSupport
test("depth-one Task agents can use specialists but cannot delegate more Tasks", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-nested-" })
      const terra = yield* routedModel({
        lanes: [
          {
            steps: [
              TestModel.toolCall("task", { prompt: "Coordinate nested work." }, { id: "call-depth-one" }),
              TestModel.toolCall("await_subagents", {}, { id: "root-join" }),
              TestModel.text("Root received the nested result."),
            ],
          },
          {
            when: (prompt) => !prompt.includes(nestedRootPrompt),
            steps: [
              TestModel.toolCall("oracle", { prompt: "Check the nested design." }, { id: "call-oracle" }),
              TestModel.toolCall("await_subagents", {}, { id: "depth-one-join" }),
              TestModel.toolCall("librarian", { prompt: "Research the nested check." }, { id: "call-librarian" }),
              TestModel.toolCall("await_subagents", {}, { id: "depth-one-join-second" }),
              TestModel.text("Depth one combined both results."),
            ],
          },
        ],
        provider: "test",
        model: "gpt-5.6-terra",
        registrationKey: "terra-medium",
      })
      const sol = yield* routedModel({
        lanes: [
          {
            when: (prompt) => prompt.includes("Check the nested design."),
            steps: [TestModel.text("Oracle checked.")],
          },
          {
            when: (prompt) => prompt.includes("Research the nested check."),
            steps: [TestModel.text("Librarian checked.")],
          },
        ],
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const terraRegistration = yield* ModelRegistry.registration({
        ...terra.selection,
        layer: terra.layer,
      })
      const solRegistration = yield* ModelRegistry.registration({ ...sol.selection, layer: sol.layer })
      const executionRoute: ExecutionBackend.ExecutionRoutePin = {
        version: 1 as const,
        mode: "test",
        main: executionModelRoute("main", terra.selection),
        oracle: executionModelRoute("oracle", sol.selection),
        title: executionModelRoute("title", terra.selection),
      }
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: terraRegistration,
        additionalRegistrations: [solRegistration],
        selection: terra.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-nested-spawn",
          turnId: "turn-nested-spawn",
          prompt: nestedRootPrompt,
          executionRoute,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly id: string; readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select e.id as id, e.status as status, s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id like 'child:%' order by e.id")
          .all()
        const failures = database
          .query<
            { readonly execution_id: string; readonly data_json: string },
            []
          >("select execution_id, data_json from relay_execution_events where execution_id like 'child:%' and type = 'execution.failed' order by execution_id")
          .all()
        const delegationResults = database
          .query<
            {
              readonly execution_id: string
              readonly name: string
              readonly input_json: string
              readonly output_json: string
              readonly error: string | null
            },
            []
          >(
            "select call.execution_id, call.name, call.input_json, result.output_json, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id like 'child:%' and call.name in ('task', 'oracle', 'librarian', 'review') order by call.created_at",
          )
          .all()
        const nestedErrors = delegationResults.filter((result) => result.error !== null)
        return {
          settled,
          children,
          failures,
          delegationResults,
          nestedErrors,
          terraRequests: yield* terra.requests,
          depthOneRequests: yield* terra.lanes[1]!.requests,
          oracleRequests: yield* sol.lanes[0]!.requests,
          librarianRequests: yield* sol.lanes[1]!.requests,
        }
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
      Effect.tap(
        ({
          settled,
          children,
          failures,
          delegationResults,
          nestedErrors,
          terraRequests,
          depthOneRequests,
          oracleRequests,
          librarianRequests,
        }) =>
          Effect.sync(() => {
            const delegationTools = new Set(["task", "oracle", "librarian", "review"])
            const depthOneTools = depthOneRequests[0]?.tools.map((tool) => tool.name) ?? []
            const depthTwoToolSets = [oracleRequests, librarianRequests].map(
              (requests) => requests[0]?.tools.map((tool) => tool.name) ?? [],
            )
            expect(settled.status).toBe("completed")
            expect(failures).toEqual([])
            expect(terraRequests.length).toBeGreaterThan(0)
            expect(delegationResults).toHaveLength(2)
            expect(delegationResults.map((result) => ({ name: result.name, error: result.error }))).toEqual([
              { name: "oracle", error: null },
              { name: "librarian", error: null },
            ])
            expect(nestedErrors).toEqual([])
            expect(children).toHaveLength(3)
            expect(children.every((child) => child.status === "completed")).toBe(true)
            expect(
              children.every(
                (child) => decodeToolExecution(child.agent_snapshot_json).tool_execution?.concurrency === "unbounded",
              ),
            ).toBe(true)
            expect(depthOneTools).not.toContain("task")
            expect(depthOneTools).toEqual(expect.arrayContaining(["oracle", "librarian"]))
            expect(depthTwoToolSets.every((tools) => !tools.some((tool) => delegationTools.has(tool)))).toBe(true)
            expect(
              children.some((child) => {
                const snapshot = JSON.parse(child.agent_snapshot_json) as {
                  readonly model?: {
                    readonly model?: string
                    readonly registration_key?: string
                    readonly metadata?: {
                      readonly rika_agent_depth?: number
                      readonly rika_reasoning_effort?: string
                    }
                  }
                }
                return (
                  snapshot.model?.model === "gpt-5.6-terra" &&
                  snapshot.model.registration_key === "terra-medium" &&
                  snapshot.model.metadata?.rika_agent_depth === 1 &&
                  snapshot.model.metadata.rika_reasoning_effort === "medium"
                )
              }),
            ).toBe(true)
            expect(
              children.some((child) => {
                const snapshot = JSON.parse(child.agent_snapshot_json) as {
                  readonly model?: {
                    readonly model?: string
                    readonly registration_key?: string
                    readonly metadata?: {
                      readonly rika_agent_depth?: number
                      readonly rika_reasoning_effort?: string
                    }
                  }
                }
                return (
                  snapshot.model?.model === "gpt-5.6-sol" &&
                  snapshot.model.registration_key === "sol-medium" &&
                  snapshot.model.metadata?.rika_agent_depth === 2 &&
                  snapshot.model.metadata.rika_reasoning_effort === "medium"
                )
              }),
            ).toBe(true)
            expect(
              settled.events
                .filter(
                  (event) => event.type === "model.output.delta" && event.executionId === "execution:turn-nested-spawn",
                )
                .map((event) => event.text)
                .join(""),
            ).toBe("Root received the nested result.")
          }),
      ),
    ),
  )
}, 60_000)
