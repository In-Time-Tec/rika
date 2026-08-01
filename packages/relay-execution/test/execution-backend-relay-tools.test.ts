import { ModelRegistry, Response } from "@batonfx/core"

import { TestModel } from "@batonfx/test"

import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Clock, Duration, Effect, FileSystem, Layer, Schedule } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { workspaceFromExecutionId } from "../src/relay/execution/relay-execution-identifier"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-layer"
const { runNative, encodeJson, decodeToolExecution } = testSupport
const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )
const withBackend = <A, E extends object, AdditionalTools extends Record<string, Tool.Any> = {}>(
  script: Parameters<typeof TestModel.make>[0],
  run: (
    fixture: TestModel.Fixture,
    directory: string,
  ) => Effect.Effect<A, E, ExecutionBackend.Service | FileSystem.FileSystem>,
  options?: Pick<
    LayerOptions<AdditionalTools>,
    "modelResilience" | "compaction" | "modelVariantPolicy" | "additionalToolkit" | "additionalHandlerLayer"
  > & {
    readonly registration?: (fixture: TestModel.Fixture) => ModelRegistry.Registration
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-" })
      const fixture = yield* TestModel.make(script)
      const { registration, ...layerOptions } = options ?? {}
      return yield* provide(
        run(fixture, directory),
        relayLayer({
          filename: `${directory}/execution.db`,
          workspace: directory,
          registration: registration?.(fixture) ?? fixture.registration,
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          ...layerOptions,
        }),
      )
    }),
  )
test(
  "delivers tool lifecycle events while the execution is still running",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.toolCall("bash", { command: "/bin/sleep 0.2", timeout_ms: 500 }, { id: "timed-tool" }),
            TestModel.turn([TestModel.text("timed tool complete")], { delay: Duration.millis(200) }),
          ],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const clock = yield* Clock.Clock
              const received: Array<{ readonly type: string; readonly at: number }> = []
              const result = yield* start(backend, {
                threadId: "thread-live-tool-events",
                turnId: "turn-live-tool-events",
                prompt: "run the timed tool",
                onEvent: (event) => received.push({ type: event.type, at: clock.currentTimeMillisUnsafe() }),
              })
              return { received, result }
            }),
        )
        const { received, result } = yield* program
        const requested = received.find((event) => event.type === "tool.call.requested")
        const completed = received.find((event) => event.type === "tool.result.received")
        const output = received.find((event) => event.type === "model.output.delta")
        expect(result.status).toBe("completed")
        expect(requested).toBeDefined()
        expect(completed).toBeDefined()
        expect(output).toBeDefined()
        expect(completed!.at - requested!.at).toBeGreaterThanOrEqual(100)
        expect(output!.at - completed!.at).toBeGreaterThanOrEqual(100)
        expect(received.map((event) => event.type).indexOf("tool.call.requested")).toBeLessThan(
          received.map((event) => event.type).indexOf("model.output.delta"),
        )
      }),
    ),
  30_000,
)
test(
  "routes durable tools to each execution's workspace",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-workspaces-" })
            const firstWorkspace = `${directory}/first`
            const secondWorkspace = `${directory}/second`
            yield* fileSystem.makeDirectory(firstWorkspace)
            yield* fileSystem.makeDirectory(secondWorkspace)
            const fixture = yield* TestModel.make([
              TestModel.toolCall("bash", { command: "sleep 0.1; printf alive > process.txt", timeout_ms: 0 }),
              TestModel.toolCall("shell_command_status", { processId: "1", waitMillis: 1_000 }),
              TestModel.toolCall("write", { path: "result.txt", content: "first" }),
              TestModel.text("first complete"),
              TestModel.toolCall("write", { path: "result.txt", content: "second" }),
              TestModel.text("second complete"),
            ])
            const workspaceByExecution = new Map([
              ["execution:first-turn", firstWorkspace],
              ["execution:second-turn", secondWorkspace],
            ])
            let runtimeBuilds = 0
            const backendLayer = relayLayer({
              filename: `${directory}/execution.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection",
              toolRuntimeLayerForWorkspace: (workspace) => {
                runtimeBuilds += 1
                return RikaToolRuntime.layerWithProcessRegistry(workspace, WorkspaceIndex.layer(workspace)).pipe(
                  Layer.catch((error) =>
                    Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: String(error) }))),
                  ),
                )
              },
              resolveWorkspace: (executionId) => {
                const workspace = workspaceByExecution.get(executionId)
                return workspace === undefined
                  ? Effect.fail(ExecutionBackend.BackendError.make({ message: `Unknown execution ${executionId}` }))
                  : Effect.succeed(workspace)
              },
            })
            yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* start(backend, { threadId: "first-thread", turnId: "first-turn", prompt: "first" })
                yield* start(backend, {
                  threadId: "second-thread",
                  turnId: "second-turn",
                  prompt: "second",
                })
              }),
              backendLayer,
            )
            const contents = yield* Effect.all([
              fileSystem.readFileString(`${firstWorkspace}/result.txt`),
              fileSystem.readFileString(`${secondWorkspace}/result.txt`),
              fileSystem.readFileString(`${firstWorkspace}/process.txt`),
            ])
            return { contents, runtimeBuilds }
          }),
        )

        expect(yield* program).toEqual({ contents: ["first", "second", "alive"], runtimeBuilds: 4 })
      }),
    ),
  30_000,
)
test(
  "routes standalone workflow child tools through the client workspace",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workflow-workspace-" })
            const workspace = `${directory}/workspace`
            yield* fileSystem.makeDirectory(workspace)
            yield* fileSystem.writeFileString(`${workspace}/fixture.txt`, "workflow workspace marker")
            const fixture = yield* TestModel.make([
              TestModel.toolCall("read", { path: "fixture.txt" }, { id: "call-workflow-read" }),
              TestModel.text("investigated"),
              TestModel.object({ answer: "investigated", evidence: [] }),
              TestModel.text("implemented"),
              TestModel.object({ summary: "implemented", files: [] }),
              TestModel.text("reviewed"),
              TestModel.object({ summary: "reviewed", findings: [] }),
              TestModel.text("fixed"),
              TestModel.object({ summary: "fixed", files: [] }),
              TestModel.text("verified"),
              TestModel.object({ summary: "verified", files: [] }),
            ])
            const backendLayer = relayLayer({
              filename: `${directory}/execution.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection",
              toolRuntimeLayerForWorkspace: (runtimeWorkspace) =>
                RikaToolRuntime.layerWithProcessRegistry(runtimeWorkspace, WorkspaceIndex.layer(runtimeWorkspace)).pipe(
                  Layer.catch((error) =>
                    Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: String(error) }))),
                  ),
                ),
              resolveWorkspace: (executionId) => {
                const resolved = workspaceFromExecutionId(executionId)
                return resolved === undefined
                  ? Effect.fail(
                      ExecutionBackend.BackendError.make({
                        message: `Unknown execution ${executionId}`,
                      }),
                    )
                  : Effect.succeed(resolved)
              },
            })
            return yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* backend.registerWorkflows()
                yield* backend.startWorkflow("delivery", "workspace-run", undefined, undefined, workspace)
                const completed = yield* backend.inspectWorkflow("workspace-run", undefined, workspace).pipe(
                  Effect.repeat({
                    while: (inspection) => inspection?.status === "running",
                    schedule: Schedule.spaced("20 millis"),
                  }),
                )
                const database = new Database(`${directory}/execution.db`, { readonly: true })
                const childSnapshots = database
                  .query<
                    { readonly agent_snapshot_json: string },
                    []
                  >("select s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id like 'child:%' order by id")
                  .all()
                database.close()
                return { completed, requests: yield* fixture.requests, childSnapshots }
              }),
              backendLayer,
            )
          }),
        )

        expect(result.completed?.status).toBe("completed")
        expect(result.completed?.runId).toBe("workspace-run")
        expect(encodeJson(result.requests)).toContain("workflow workspace marker")
        expect(result.childSnapshots).not.toHaveLength(0)
        expect(
          result.childSnapshots.every(
            (child) => decodeToolExecution(child.agent_snapshot_json).tool_execution?.concurrency === "unbounded",
          ),
        ).toBe(true)
      }),
    ),
  60_000,
)
test(
  "streams grouped model parts and persists usage through Relay SQLite",
  () =>
    runNative(
      Effect.gen(function* () {
        const usage = Response.Usage.make({
          inputTokens: { uncached: 7, total: 7, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        })
        const result = yield* withBackend(
          [TestModel.turn([TestModel.text("group "), TestModel.text("stream")], { usage })],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const completed = yield* start(backend, {
                threadId: "thread-stream",
                turnId: "turn-stream",
                prompt: "go",
              })
              return yield* backend.replay(completed.turnId)
            }),
        )
        expect(result.status).toBe("completed")
        expect(
          result.events
            .filter((event) => event.type === "model.cycle.completed")
            .map((event) => event.text)
            .join(""),
        ).toBe("group stream")
        expect(result.events.map((event) => event.type)).toContain("model.usage.reported")
      }),
    ),
  30_000,
)
