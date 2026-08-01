import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import * as BunServices from "@effect/platform-bun/BunServices"

import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Ref } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import { layer } from "../src/relay/execution/relay-execution-layer"
import { routedModel } from "./routed-model"
import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-spawn-fixture"
const { executionModelRoute } = testSupport
test("a nested subagent delegates ReadThread without broadening its Relay scope", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-nested-read-thread-agent-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("oracle", { prompt: "Recover the earlier requirement." }, { id: "oracle" }),
          TestModel.toolCall("await_subagents", {}, { id: "root-join" }),
          TestModel.text("Root received the recovered requirement."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-xhigh" },
      )
      const oracle = yield* routedModel({
        lanes: [
          {
            steps: [
              TestModel.toolCall("read_thread", { prompt: "Read the current thread." }, { id: "read-thread" }),
              TestModel.toolCall("await_subagents", {}, { id: "oracle-join" }),
              TestModel.toolCall(
                "read_thread_transcript",
                { threadId: "thread-nested-current-context", maxTurns: 1, maxChars: 1_000 },
                { id: "read-transcript" },
              ),
              TestModel.text("Oracle recovered the nested requirement."),
            ],
          },
          {
            when: (prompt) => !prompt.includes("Recover the earlier requirement."),
            steps: [TestModel.text("The thread required exact nested recovery.")],
          },
        ],
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const transcriptReads = yield* Ref.make(0)
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [oracle.registration],
        selection: main.selection,
        additionalToolkit: ThreadToolkits.ThreadContract.toolkit,
        additionalHandlerLayer: ThreadToolkits.ThreadContract.toolkit.toLayer({
          search_threads: () => Effect.succeed({ text: "", truncated: false }),
          read_thread_transcript: () =>
            Ref.update(transcriptReads, (count) => count + 1).pipe(
              Effect.as({ text: "Earlier thread context.", truncated: false }),
            ),
        }),
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const route: ExecutionBackend.ExecutionRoutePin = {
          version: 1 as const,
          mode: "medium",
          main: executionModelRoute("main", main.selection, "xhigh"),
          oracle: executionModelRoute("oracle", oracle.selection, "medium"),
        }
        const settled = yield* start(backend, {
          threadId: "thread-nested-current-context",
          turnId: "turn-nested-current-context",
          prompt: "Ask Oracle to recover this thread's earlier requirement.",
          executionRoute: route,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly status: string },
            []
          >("select status from relay_executions where id like 'child:%' order by id")
          .all()
        const failures = database
          .query<
            { readonly data_json: string },
            []
          >("select data_json from relay_execution_events where execution_id like 'child:%' and type = 'execution.failed' order by execution_id")
          .all()
        const readThreadResults = database
          .query<
            { readonly error: string | null },
            []
          >("select result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id like 'child:%' and call.name = 'read_thread'")
          .all()
        return {
          settled,
          children,
          failures,
          readThreadResults,
          transcriptReads: yield* Ref.get(transcriptReads),
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
      Effect.tap(({ settled, children, failures, readThreadResults, transcriptReads }) =>
        Effect.sync(() => {
          expect(settled.status).toBe("completed")
          expect(children).toHaveLength(2)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(failures).toEqual([])
          expect(readThreadResults).toEqual([{ error: null }])
          expect(transcriptReads).toBe(1)
        }),
      ),
    ),
  )
}, 60_000)
test("parallel Task calls fall back to the pinned main Sol route when no agent routes are pinned", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-high-models-" })
      const sol = yield* TestModel.make(
        [
          TestModel.turn([
            TestModel.toolCall("task", { prompt: "Explore alpha." }, { id: "call-alpha" }),
            TestModel.toolCall("task", { prompt: "Explore beta." }, { id: "call-beta" }),
            TestModel.toolCall("task", { prompt: "Explore gamma." }, { id: "call-gamma" }),
          ]),
          TestModel.text("Sol completed alpha."),
          TestModel.text("Sol completed beta."),
          TestModel.text("Sol completed gamma."),
          TestModel.text("All pinned tasks completed."),
        ],
        { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-xhigh" },
      )
      const executionRoute: ExecutionBackend.ExecutionRoutePin = {
        version: 1 as const,
        mode: "high",
        main: executionModelRoute("main", sol.selection, "xhigh"),
        oracle: executionModelRoute(
          "oracle",
          { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-max" },
          "max",
        ),
        title: executionModelRoute("title", { provider: "legacy", model: "luna" }, "low"),
        compactionSummary: executionModelRoute("compaction", { provider: "legacy", model: "terra" }, "medium"),
      }
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: sol.registration,
        selection: sol.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-high-models",
          turnId: "turn-high-models",
          prompt: "Run three tasks together.",
          executionRoute,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select e.status as status, s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id like 'child:%' order by e.id")
          .all()
        const childRuns = database
          .query<
            { readonly id: string; readonly metadata_json: string },
            []
          >("select id, metadata_json from relay_child_executions order by id")
          .all()
        const results = database
          .query<
            { readonly error: string | null },
            []
          >("select result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id = 'execution:turn-high-models' and call.name = 'task' order by call.created_at")
          .all()
        return { settled, children, childRuns, results }
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
      Effect.tap(({ settled, children, childRuns, results }) =>
        Effect.sync(() => {
          expect(settled.status).toBe("completed")
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(results).toEqual([{ error: null }, { error: null }, { error: null }])
          expect(childRuns).toHaveLength(3)
          expect(
            children.map((child) => {
              const snapshot = JSON.parse(child.agent_snapshot_json) as {
                readonly model?: { readonly model?: string; readonly registration_key?: string }
              }
              return [snapshot.model?.model, snapshot.model?.registration_key]
            }),
          ).toEqual([
            ["gpt-5.6-sol", "sol-xhigh"],
            ["gpt-5.6-sol", "sol-xhigh"],
            ["gpt-5.6-sol", "sol-xhigh"],
          ])
          expect(
            children.map(
              ({ agent_snapshot_json }) => JSON.parse(agent_snapshot_json).model?.metadata?.rika_reasoning_effort,
            ),
          ).toEqual(["xhigh", "xhigh", "xhigh"])
        }),
      ),
    ),
  )
}, 60_000)
