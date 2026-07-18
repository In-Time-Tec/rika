import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Clock, Effect, FileSystem, Layer, Ref, Schedule, Schema, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const executionModelRoute = (
  role: ExecutionBackend.ExecutionModelRoute["role"],
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
  effort = "medium",
): ExecutionBackend.ExecutionModelRoute => ({
  role,
  alias: role,
  provider: selection.provider,
  model: selection.model,
  registrationKey: selection.registrationKey ?? role,
  providerProtocol: "test",
  providerBaseUrl: "test://model",
  effort,
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
})

test("three Task calls in one model turn run as overlapping durable children", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-parallel-" })
      const fixture = yield* TestModel.make([
        TestModel.turn([
          TestModel.toolCall("task", { prompt: "Explore alpha." }, { id: "call-alpha" }),
          TestModel.toolCall("task", { prompt: "Explore beta." }, { id: "call-beta" }),
          TestModel.toolCall("task", { prompt: "Explore gamma." }, { id: "call-gamma" }),
        ]),
        TestModel.turn([TestModel.text("alpha")], { delay: "400 millis" }),
        TestModel.turn([TestModel.text("beta")], { delay: "400 millis" }),
        TestModel.turn([TestModel.text("gamma")], { delay: "400 millis" }),
        TestModel.object({ summary: "alpha", files: [] }),
        TestModel.object({ summary: "beta", files: [] }),
        TestModel.object({ summary: "gamma", files: [] }),
        TestModel.text("All three explorations finished."),
      ])
      const windows = yield* Ref.make<
        Array<{ readonly prompt: string; readonly startedAt: number; readonly completedAt?: number }>
      >([])
      const trackingLayer = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel
          const streamText = ((options: Parameters<LanguageModel.Service["streamText"]>[0]) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const prompt = encodeJson(options.prompt)
                const startedAt = yield* Clock.currentTimeMillis
                const index = yield* Ref.modify(windows, (current) => [
                  current.length,
                  [...current, { prompt, startedAt }],
                ])
                return model
                  .streamText(options)
                  .pipe(
                    Stream.ensuring(
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((completedAt) =>
                          Ref.update(windows, (current) =>
                            current.map((window, currentIndex) =>
                              currentIndex === index ? { ...window, completedAt } : window,
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
              }),
            )) as LanguageModel.Service["streamText"]
          return { ...model, streamText }
        }),
      ).pipe(Layer.provide(fixture.layer))
      const registration = yield* ModelRegistry.registrationFromLayer({
        ...fixture.selection,
        layer: trackingLayer,
      })
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-parallel-spawn",
          turnId: "turn-parallel-spawn",
          prompt: "Explore alpha, beta, and gamma independently.",
          startedAt: 1,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly id: string; readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select id, status, agent_snapshot_json from relay_executions where id like 'child:%' order by id")
          .all()
        const childRuns = database
          .query<
            { readonly id: string; readonly metadata_json: string },
            []
          >("select id, metadata_json from relay_child_executions order by id")
          .all()
        return {
          settled,
          children,
          childRuns,
          selection: fixture.selection,
          requests: yield* fixture.requests,
          windows: yield* Ref.get(windows),
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
      Effect.tap(({ settled, children, childRuns, selection, requests, windows }) =>
        Effect.sync(() => {
          const childWindows = windows.slice(1, 4)
          expect(settled.status).toBe("completed")
          expect(settled.events.filter((event) => event.type === "child_run.spawned")).toHaveLength(3)
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(
            childRuns
              .map(({ metadata_json }) => JSON.parse(metadata_json))
              .map(({ kind, preset_name }) => ({
                kind,
                preset_name,
              })),
          ).toEqual([
            { kind: "static", preset_name: "Task" },
            { kind: "static", preset_name: "Task" },
            { kind: "static", preset_name: "Task" },
          ])
          expect(
            children.map(({ agent_snapshot_json }) => {
              const snapshot = JSON.parse(agent_snapshot_json) as {
                readonly model?: { readonly model?: string; readonly registration_key?: string }
              }
              return [snapshot.model?.model, snapshot.model?.registration_key]
            }),
          ).toEqual([
            [selection.model, selection.registrationKey],
            [selection.model, selection.registrationKey],
            [selection.model, selection.registrationKey],
          ])
          expect(windows).toHaveLength(5)
          expect(childWindows).toHaveLength(3)
          expect(
            childWindows.every((window) =>
              ["Explore alpha.", "Explore beta.", "Explore gamma."].some((prompt) => window.prompt.includes(prompt)),
            ),
          ).toBe(true)
          expect(Math.max(...childWindows.map((window) => window.startedAt))).toBeLessThan(
            Math.min(...childWindows.map((window) => window.completedAt ?? 0)),
          )
          expect(requests.slice(1, 4).every((request) => request.operation === "streamText")).toBe(true)
          expect(
            settled.events
              .filter((event) => event.type === "model.output.delta")
              .map((event) => event.text)
              .join(""),
          ).toBe("All three explorations finished.")
        }),
      ),
    ),
  )
}, 60_000)

test("high mode runs Luna, Terra, and inherited Sol Task calls in one batch", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-high-models-" })
      const sol = yield* TestModel.make(
        [
          TestModel.turn([
            TestModel.toolCall("task", { prompt: "Explore with Luna.", model: "gpt-5.6-luna" }, { id: "call-luna" }),
            TestModel.toolCall("task", { prompt: "Explore with Terra.", model: "gpt-5.6-terra" }, { id: "call-terra" }),
            TestModel.toolCall("task", { prompt: "Explore with inherited Sol." }, { id: "call-sol" }),
          ]),
          TestModel.text("Sol completed its exploration."),
          TestModel.object({ summary: "Sol exploration complete.", files: [] }),
          TestModel.text("All model choices completed."),
        ],
        { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-xhigh" },
      )
      const luna = yield* TestModel.make(
        [
          TestModel.text("Luna completed its exploration."),
          TestModel.object({ summary: "Luna exploration complete.", files: [] }),
        ],
        { provider: "test", model: "gpt-5.6-luna", registrationKey: "luna-low" },
      )
      const terra = yield* TestModel.make(
        [
          TestModel.text("Terra completed its exploration."),
          TestModel.object({ summary: "Terra exploration complete.", files: [] }),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const executionRoute: ExecutionBackend.ExecutionRoutePin = {
        mode: "high",
        main: executionModelRoute("main", sol.selection, "xhigh"),
        oracle: executionModelRoute(
          "oracle",
          { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-max" },
          "max",
        ),
        title: executionModelRoute("title", luna.selection, "low"),
        compactionSummary: executionModelRoute("compaction", terra.selection, "medium"),
        agents: {
          librarian: executionModelRoute(
            "librarian",
            { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-high" },
            "high",
          ),
          painter: executionModelRoute(
            "painter",
            { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-high" },
            "high",
          ),
          review: executionModelRoute(
            "review",
            { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-high" },
            "high",
          ),
          readThread: executionModelRoute("readThread", terra.selection, "medium"),
          task: executionModelRoute("task", terra.selection, "medium"),
        },
      }
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: sol.registration,
        additionalRegistrations: [luna.registration, terra.registration],
        selection: sol.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-high-models",
          turnId: "turn-high-models",
          prompt: "Run Luna, Terra, and inherited Sol together.",
          startedAt: 1,
          executionRoute,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select status, agent_snapshot_json from relay_executions where id like 'child:%' order by id")
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
          const childRunMetadata = (callId: string) => {
            const child = childRuns.find(({ id }) => id.endsWith(`:${callId}`))
            return child === undefined ? undefined : JSON.parse(child.metadata_json)
          }
          expect(childRunMetadata("call-sol")).toMatchObject({ kind: "static", preset_name: "Task" })
          expect(childRunMetadata("call-luna")).toMatchObject({ kind: "dynamic" })
          expect(childRunMetadata("call-luna")).not.toHaveProperty("preset_name")
          expect(childRunMetadata("call-terra")).toMatchObject({ kind: "dynamic" })
          expect(childRunMetadata("call-terra")).not.toHaveProperty("preset_name")
          expect(
            children.map((child) => {
              const snapshot = JSON.parse(child.agent_snapshot_json) as {
                readonly model?: { readonly model?: string; readonly registration_key?: string }
              }
              return [snapshot.model?.model, snapshot.model?.registration_key]
            }),
          ).toEqual(
            expect.arrayContaining([
              ["gpt-5.6-luna", "luna-low"],
              ["gpt-5.6-terra", "terra-medium"],
              ["gpt-5.6-sol", "sol-xhigh"],
            ]),
          )
        }),
      ),
    ),
  )
}, 60_000)

test("depth-one agents call specialists and spawn a chosen depth-two model without depth-three tools", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-nested-" })
      const terra = yield* TestModel.make(
        [
          TestModel.toolCall("task", { prompt: "Coordinate nested work." }, { id: "call-depth-one" }),
          TestModel.turn([
            TestModel.toolCall("oracle", { prompt: "Check the nested design." }, { id: "call-oracle" }),
            TestModel.toolCall(
              "task",
              { prompt: "Do a cheap nested check.", model: "gpt-5.6-luna" },
              { id: "call-depth-two" },
            ),
          ]),
          TestModel.text("Depth one combined both results."),
          TestModel.object({ summary: "Nested work complete.", files: [] }),
          TestModel.text("Root received the nested result."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const luna = yield* TestModel.make(
        [
          TestModel.text("Luna completed the nested check."),
          TestModel.object({ summary: "Luna nested check complete.", files: [] }),
        ],
        { provider: "test", model: "gpt-5.6-luna", registrationKey: "luna-medium" },
      )
      const sol = yield* TestModel.make(
        [
          TestModel.text("Oracle checked the nested design."),
          TestModel.object({ answer: "The nested design is sound.", evidence: [] }),
        ],
        { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-medium" },
      )
      const executionRoute: ExecutionBackend.ExecutionRoutePin = {
        mode: "test",
        main: executionModelRoute("main", terra.selection),
        oracle: executionModelRoute("oracle", sol.selection),
        title: executionModelRoute("title", luna.selection),
        agents: {
          librarian: executionModelRoute("librarian", terra.selection),
          painter: executionModelRoute("painter", terra.selection),
          review: executionModelRoute("review", terra.selection),
          readThread: executionModelRoute("readThread", terra.selection),
          task: executionModelRoute("task", terra.selection),
        },
      }
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: terra.registration,
        additionalRegistrations: [luna.registration, sol.registration],
        selection: terra.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-nested-spawn",
          turnId: "turn-nested-spawn",
          prompt: "Coordinate nested work.",
          startedAt: 1,
          executionRoute,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly id: string; readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select id, status, agent_snapshot_json from relay_executions where id like 'child:%' order by id")
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
            "select call.execution_id, call.name, call.input_json, result.output_json, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id like 'child:%' and call.name in ('task', 'oracle') order by call.created_at",
          )
          .all()
        return {
          settled,
          children,
          failures,
          delegationResults,
          terraRequests: yield* terra.requests,
          lunaRequests: yield* luna.requests,
          solRequests: yield* sol.requests,
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
      Effect.tap(({ settled, children, failures, delegationResults, terraRequests, lunaRequests, solRequests }) =>
        Effect.sync(() => {
          const delegationTools = ["task", "oracle", "librarian", "review"]
          const depthOneTools = terraRequests[1]?.tools.map((tool) => tool.name) ?? []
          const lunaDepthTwoTools = lunaRequests[0]?.tools.map((tool) => tool.name) ?? []
          const oracleDepthTwoTools = solRequests[0]?.tools.map((tool) => tool.name) ?? []
          expect(settled.status).toBe("completed")
          expect(failures).toEqual([])
          expect(terraRequests).toHaveLength(5)
          expect(delegationResults).toHaveLength(2)
          expect(delegationResults.map((result) => ({ name: result.name, error: result.error }))).toEqual([
            { name: "oracle", error: null },
            { name: "task", error: null },
          ])
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(depthOneTools).toEqual(expect.arrayContaining(delegationTools))
          expect(lunaDepthTwoTools).not.toEqual(expect.arrayContaining(delegationTools))
          expect(oracleDepthTwoTools).not.toEqual(expect.arrayContaining(delegationTools))
          expect(lunaRequests).toHaveLength(2)
          expect(solRequests).toHaveLength(2)
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
                snapshot.model?.model === "gpt-5.6-luna" &&
                snapshot.model.registration_key === "luna-medium" &&
                snapshot.model.metadata?.rika_agent_depth === 2 &&
                snapshot.model.metadata.rika_reasoning_effort === "medium"
              )
            }),
          ).toBe(true)
          expect(
            settled.events
              .filter((event) => event.type === "model.output.delta")
              .map((event) => event.text)
              .join(""),
          ).toBe("Root received the nested result.")
        }),
      ),
    ),
  )
}, 60_000)

test("model spawns a durable Oracle child through the handoff tool and resumes with its result", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-" })
      const fixture = yield* TestModel.make([
        TestModel.toolCall("oracle", { prompt: "Investigate the boundary." }, { id: "call-oracle" }),
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
        const childExecutionId = `child:${encodeURIComponent("execution:turn-subagent")}:rika:${encodeURIComponent("execution:turn-subagent")}:call-oracle`
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
        TestModel.toolCall("review", { prompt: "Inspect AGENTS.md." }, { id: "call-review" }),
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
        TestModel.toolCall("review", { prompt: "Read fixture.txt." }, { id: "call-parent-review" }),
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
          expect(String(ask?.data?.execution_id).startsWith("child:execution%3Aturn-child-permission:")).toBe(true)
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
        TestModel.toolCall("review", { prompt: "Read fixture.txt." }, { id: "call_shared" }),
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
