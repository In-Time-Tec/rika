import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, ModelResilience, Response } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime as RikaToolRuntime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Clock, Duration, Effect, Fiber, FileSystem, Layer, Schedule, Schema } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { createFanOut, start } from "./current-execution-route"

const executionModelRoute = (
  role: "main" | "oracle",
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionBackend.ExecutionModelRoute => ({
  role,
  alias: role,
  provider: selection.provider,
  model: selection.model,
  registrationKey: selection.registrationKey ?? role,
  providerProtocol: "test",
  providerBaseUrl: "test://model",
  effort: "medium",
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 50 },
})

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const withBackend = <A, E>(
  script: Parameters<typeof TestModel.make>[0],
  run: (
    fixture: TestModel.Fixture,
    directory: string,
  ) => Effect.Effect<A, E, ExecutionBackend.Service | FileSystem.FileSystem>,
  options?: Pick<RelayExecutionBackend.LayerOptions, "modelResilience" | "compaction" | "permissionPolicy">,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-" })
      const fixture = yield* TestModel.make(script)
      return yield* provide(
        run(fixture, directory),
        RelayExecutionBackend.layer({
          filename: `${directory}/relay.db`,
          workspace: directory,
          registration: fixture.registration,
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          ...options,
        }),
      )
    }),
  )

test(
  "completes idempotently and replays from a cursor",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend([TestModel.text("deterministic answer")], (fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const streamed: Array<ExecutionBackend.Event> = []
            const input = {
              threadId: "thread-a",
              turnId: "turn-a",
              prompt: "hello",
              startedAt: 1,
              onEvent: (event: ExecutionBackend.Event) => streamed.push(event),
            }
            const first = yield* start(backend, input)
            const { onEvent: _onEvent, ...duplicateInput } = input
            const duplicate = yield* start(backend, duplicateInput)
            const replay = yield* backend.replay(input.turnId)
            const cursor = replay.events.at(1)?.cursor
            const after = yield* backend.replay(input.turnId, cursor)
            return { first, duplicate, replay, after, streamed, requests: yield* fixture.requests }
          }),
        )
        const result = yield* program
        expect(result.first.status).toBe("completed")
        expect(result.first.events.map((event) => event.type)).toContain("model.output.completed")
        expect(result.streamed).toEqual([...result.first.events])
        expect(result.duplicate.events.map((event) => event.cursor)).toEqual(
          result.first.events.map((event) => event.cursor),
        )
        expect(result.replay.events.map((event) => event.cursor)).toEqual(
          result.first.events.map((event) => event.cursor),
        )
        expect(result.after.events[0]?.cursor).not.toBe(result.replay.events[0]?.cursor)
        expect(result.requests).toHaveLength(1)
      }),
    ),
  30_000,
)

test(
  "executes the Rika toolkit through Relay and returns the result to Baton",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "read-1" })]),
            TestModel.text("tool complete"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "tool fixture")
              const backend = yield* ExecutionBackend.Service
              const result = yield* start(backend, {
                threadId: "thread-tools",
                turnId: "turn-tools",
                prompt: "read fixture.txt",
                startedAt: 1,
              })
              return { result, requests: yield* fixture.requests }
            }),
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(encodeJson(result.requests[1])).toContain("fixture.txt")
      }),
    ),
  30_000,
)

test(
  "keeps provider tool-call identifiers on the wire and namespaces durable keys by execution",
  () =>
    runNative(
      Effect.gen(function* () {
        const originalCallId = `call_${"a".repeat(59)}`
        const program = withBackend(
          [
            TestModel.toolCall("find_files", { query: "fixture" }, { id: originalCallId }),
            TestModel.text("first tool turn complete"),
            TestModel.toolCall("find_files", { query: "fixture" }, { id: originalCallId }),
            TestModel.text("second tool turn complete"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const first = yield* start(backend, {
                threadId: "thread-reused-call-id",
                turnId: "first-reused-call-id",
                prompt: "first",
                startedAt: 1,
              })
              const second = yield* start(backend, {
                threadId: "thread-reused-call-id",
                turnId: "second-reused-call-id",
                prompt: "second",
                startedAt: 2,
              })
              const calls = yield* Effect.acquireUseRelease(
                Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
                (database) =>
                  Effect.sync(() =>
                    database
                      .query<
                        { readonly id: string; readonly execution_id: string },
                        []
                      >("select id, execution_id from relay_tool_calls order by execution_id")
                      .all(),
                  ),
                (connection) => Effect.sync(() => connection.close()),
              )
              return { first, second, calls, requests: yield* fixture.requests }
            }),
          { compaction: { contextWindow: 1_000_000, reserveTokens: 100, keepRecentTokens: 100 } },
        )
        const result = yield* program
        expect(result.first.status).toBe("completed")
        expect(result.second.status).toBe("completed")
        expect(result.calls).toHaveLength(2)
        for (const call of result.calls)
          expect(call.id).toBe(`rika:${encodeURIComponent(call.execution_id)}:${originalCallId}`)
        const secondTurnRequest = result.requests[2]
        expect(secondTurnRequest).toBeDefined()
        const replayedCallIds = secondTurnRequest!.prompt.content.flatMap((message) =>
          typeof message.content === "string"
            ? []
            : message.content.flatMap((part) =>
                part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [],
              ),
        )
        expect(replayedCallIds).toEqual([originalCallId, originalCallId])
        expect(encodeJson(secondTurnRequest!.prompt.content)).toContain("first")
        expect(encodeJson(secondTurnRequest!.prompt.content)).toContain("second")
        const providerCallIds = result.requests.flatMap((request) =>
          request.prompt.content.flatMap((message) =>
            typeof message.content === "string"
              ? []
              : message.content.flatMap((part) =>
                  part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [],
                ),
          ),
        )
        expect(providerCallIds.length).toBeGreaterThan(0)
        expect(providerCallIds.every((callId) => callId === originalCallId && callId.length <= 64)).toBe(true)
      }),
    ),
  30_000,
)

test(
  "delivers tool lifecycle events while the execution is still running",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.toolCall(
              "shell",
              { command: "/bin/sleep", args: ["0.2"], waitMillis: 500 },
              { id: "timed-tool" },
            ),
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
                startedAt: 1,
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
        expect(output!.at - requested!.at).toBeLessThan(1_000)
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
              TestModel.toolCall("create_file", { path: "result.txt", content: "first" }),
              TestModel.text("first complete"),
              TestModel.toolCall("create_file", { path: "result.txt", content: "second" }),
              TestModel.text("second complete"),
            ])
            const workspaceByExecution = new Map([
              ["execution:first-turn", firstWorkspace],
              ["execution:second-turn", secondWorkspace],
            ])
            const backendLayer = RelayExecutionBackend.layer({
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection",
              toolRuntimeLayerForWorkspace: RikaToolRuntime.layer,
              resolveWorkspace: (executionId) => {
                const workspace = workspaceByExecution.get(executionId)
                return workspace === undefined
                  ? Effect.fail(ExecutionBackend.BackendError.make({ message: `Unknown execution ${executionId}` }))
                  : Effect.succeed(workspace)
              },
              toolNeedsApproval: () => false,
              permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
            })
            yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* start(backend, { threadId: "first-thread", turnId: "first-turn", prompt: "first", startedAt: 1 })
                yield* start(backend, {
                  threadId: "second-thread",
                  turnId: "second-turn",
                  prompt: "second",
                  startedAt: 2,
                })
              }),
              backendLayer,
            )
            return yield* Effect.all([
              fileSystem.readFileString(`${firstWorkspace}/result.txt`),
              fileSystem.readFileString(`${secondWorkspace}/result.txt`),
            ])
          }),
        )

        expect(yield* program).toEqual(["first", "second"])
      }),
    ),
  30_000,
)

test(
  "routes workflow child tools through the workspace of the owning turn",
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
              TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "call-workflow-read" }),
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
            const workspaces = new Map([["turn-workflow", workspace]])
            const backendLayer = RelayExecutionBackend.layer({
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection",
              toolRuntimeLayerForWorkspace: RikaToolRuntime.layer,
              resolveWorkspace: (executionId) => {
                const turnId = RelayExecutionBackend.turnIdFromExecutionId(executionId)
                const resolved = turnId === undefined ? undefined : workspaces.get(turnId)
                return resolved === undefined
                  ? Effect.fail(
                      ExecutionBackend.BackendError.make({
                        message:
                          turnId === undefined ? `Unknown execution ${executionId}` : `Turn ${turnId} does not exist`,
                      }),
                    )
                  : Effect.succeed(resolved)
              },
              toolNeedsApproval: () => false,
              permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
            })
            return yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* backend.registerWorkflows()
                yield* backend.startWorkflow("delivery", "workspace-run", undefined, "turn-workflow")
                const completed = yield* backend.inspectWorkflow("workspace-run", "turn-workflow").pipe(
                  Effect.repeat({
                    while: (inspection) => inspection?.status === "running",
                    schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(1_000)),
                  }),
                )
                return { completed, requests: yield* fixture.requests }
              }),
              backendLayer,
            )
          }),
        )

        expect(result.completed?.status).toBe("completed")
        expect(encodeJson(result.requests)).toContain("workflow workspace marker")
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
                startedAt: 1,
              })
              return yield* backend.replay(completed.turnId)
            }),
        )
        expect(result.status).toBe("completed")
        expect(
          result.events
            .filter((event) => event.type === "model.output.delta")
            .map((event) => event.text)
            .join(""),
        ).toBe("group stream")
        expect(result.events.map((event) => event.type)).toContain("model.usage.reported")
      }),
    ),
  30_000,
)

test.skipIf(!("reasoning" in TestModel))(
  "projects and replays reasoning separately from assistant text",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* withBackend(
          [TestModel.turn([TestModel.reasoning("inspect state"), TestModel.text("final answer")])],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const completed = yield* start(backend, {
                threadId: "thread-reasoning",
                turnId: "turn-reasoning",
                prompt: "reason",
                startedAt: 1,
              })
              return { completed, replay: yield* backend.replay(completed.turnId) }
            }),
        )
        const reasoning = result.completed.events.filter((event) => event.type === "model.reasoning.delta")
        const assistant = result.completed.events.filter((event) => event.type === "model.output.delta")
        expect(reasoning.map((event) => event.text).join("")).toBe("inspect state")
        expect(assistant.map((event) => event.text).join("")).toBe("final answer")
        expect(reasoning[0]?.cursor).not.toBe(assistant[0]?.cursor)
        expect(result.replay.events).toEqual(result.completed.events)
      }),
    ),
  30_000,
)

test(
  "corrects unknown and malformed tool calls at the durable model boundary",
  () =>
    runNative(
      Effect.gen(function* () {
        const cases = [
          ["turn-unknown", "not_a_rika_tool", {}],
          ["turn-malformed", "read_file", { path: 42 }],
        ] as const
        yield* Effect.forEach(cases, ([turnId, name, params]) =>
          Effect.gen(function* () {
            const outcome = yield* withBackend(
              [TestModel.toolCall(name, params, { id: turnId }), TestModel.text("corrected")],
              (fixture) =>
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const result = yield* start(backend, { threadId: turnId, turnId, prompt: "call tool", startedAt: 1 })
                  return { result, requests: yield* fixture.requests }
                }),
            )
            expect(outcome.result.status).toBe("completed")
            expect(
              outcome.result.events
                .filter((event) => event.type === "model.output.delta")
                .map((event) => event.text)
                .join(""),
            ).toBe("corrected")
            expect(outcome.requests).toHaveLength(2)
          }),
        )
      }),
    ),
  30_000,
)

test(
  "preserves a canonical terminal failure",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* withBackend(
          Array.from({ length: 3 }, (_, index) =>
            TestModel.toolCall("not_a_rika_tool", {}, { id: `invalid-tool-${index}` }),
          ),
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              return yield* start(backend, {
                threadId: "thread-failure",
                turnId: "turn-failure",
                prompt: "fail",
                startedAt: 1,
              })
            }),
        )
        const failures = result.events.filter((event) => event.type === "execution.failed")
        expect(result.status).toBe("failed")
        expect(failures).toHaveLength(1)
        expect(failures[0]?.data?.message).toBe(failures[0]?.text)
        expect(failures[0]?.text).toContain("not_a_rika_tool")
      }),
    ),
  120_000,
)

test(
  "settles a Rika fan-out child",
  () =>
    runNative(
      Effect.gen(function* () {
        const childOutput =
          'CHILD_OK{"type":"structured","value":{"summary":"CHILD_OK","files":[]},"schema_ref":"rika.agent.task.v1"}'
        const result = yield* withBackend(
          [
            TestModel.text("parent ready"),
            TestModel.text("CHILD_OK"),
            TestModel.object({ summary: "CHILD_OK", files: [] }),
          ],
          (_, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              yield* start(backend, {
                threadId: "thread-long-child",
                turnId: "turn-long-child-parent",
                prompt: "prepare fan-out",
                startedAt: 1,
              })
              yield* createFanOut(backend, {
                parentTurnId: "turn-long-child-parent",
                fanOutId: "fan-out:long-child",
                children: [{ childId: "long-child", prompt: "produce the child result" }],
                maxConcurrency: 1,
                join: "all",
                createdAt: 2,
              })
              const fanOut = yield* backend.inspectFanOut("fan-out:long-child").pipe(
                Effect.repeat({
                  while: (inspection) => inspection?.state === "joining",
                  schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
                }),
              )
              const database = new Database(`${directory}/relay.db`, { readonly: true })
              const childExecutions = database
                .query<
                  { readonly id: string; readonly status: string },
                  []
                >("select id, status from relay_executions where id = 'child:turn-long-child-parent:long-child'")
                .all()
              database.close()
              return { fanOut, childExecutions }
            }),
        )
        expect(result.fanOut?.state).toBe("satisfied")
        expect(result.childExecutions).toEqual([{ id: "child:turn-long-child-parent:long-child", status: "completed" }])
        expect(result.fanOut?.members).toEqual([
          {
            childId: "long-child",
            ordinal: 0,
            state: "completed",
            output: childOutput,
          },
        ])
      }),
    ),
  60_000,
)

test(
  "executes persisted main and Oracle fan-out routes without enforcing a legacy route budget",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-routes-" })
            const main = yield* TestModel.make(
              [
                TestModel.text("parent-main"),
                TestModel.text("child-main"),
                TestModel.object({ summary: "child-main", files: [] }),
              ],
              {
                provider: "main-provider",
                model: "main-model",
                registrationKey: "main",
              },
            )
            const oracle = yield* TestModel.make(
              [TestModel.text("child-oracle"), TestModel.object({ answer: "child-oracle", evidence: [] })],
              {
                provider: "oracle-provider",
                model: "oracle-model",
                registrationKey: "oracle",
              },
            )
            const executionRoute: ExecutionBackend.ExecutionRoutePin = {
              mode: "test",
              tokenBudget: 1_000,
              main: executionModelRoute("main", main.selection),
              oracle: executionModelRoute("oracle", oracle.selection),
            }
            return yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* start(backend, {
                  threadId: "thread-routes",
                  turnId: "turn-routes-parent",
                  prompt: "prepare fan-out",
                  startedAt: 1,
                  executionRoute,
                })
                yield* createFanOut(backend, {
                  parentTurnId: "turn-routes-parent",
                  fanOutId: "fan-out:routes",
                  executionRoute,
                  children: [
                    { childId: "oracle-route", profile: "Oracle", prompt: "ask Oracle" },
                    { childId: "main-route", profile: "Task", prompt: "ask main" },
                  ],
                  maxConcurrency: 2,
                  join: "all",
                  createdAt: 2,
                })
                const fanOut = yield* backend.inspectFanOut("fan-out:routes").pipe(
                  Effect.repeat({
                    while: (inspection) => inspection?.state === "joining",
                    schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
                  }),
                )
                return {
                  fanOut,
                  mainRequests: yield* main.requests,
                  oracleRequests: yield* oracle.requests,
                }
              }),
              RelayExecutionBackend.layer({
                filename: `${directory}/relay.db`,
                workspace: directory,
                registration: main.registration,
                additionalRegistrations: [oracle.registration],
                selection: main.selection,
                oracleSelection: oracle.selection,
              }),
            )
          }),
        )
        expect(result.fanOut?.state).toBe("satisfied")
        expect(result.fanOut?.members.map((member) => member.output)).toEqual([
          'child-oracle{"type":"structured","value":{"answer":"child-oracle","evidence":[]},"schema_ref":"rika.agent.oracle.v1"}',
          'child-main{"type":"structured","value":{"summary":"child-main","files":[]},"schema_ref":"rika.agent.task.v1"}',
        ])
        expect(result.mainRequests).toHaveLength(3)
        expect(result.oracleRequests).toHaveLength(2)
        expect(encodeJson(result.mainRequests[1]?.prompt)).toContain("ask main")
        expect(encodeJson(result.oracleRequests[0]?.prompt)).toContain("ask Oracle")
      }),
    ),
  60_000,
)

test(
  "retries a transient TestModel failure inside the durable execution",
  () =>
    runNative(
      Effect.gen(function* () {
        const retryable = AiError.make({
          module: "test",
          method: "streamText",
          reason: AiError.RateLimitError.make({}),
        })
        const program = withBackend(
          [TestModel.failure(retryable), TestModel.text("recovered")],
          (fixture) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const result = yield* start(backend, {
                threadId: "thread-retry",
                turnId: "turn-retry",
                prompt: "retry",
                startedAt: 1,
              })
              return { result, requests: yield* fixture.requests }
            }),
          { modelResilience: ModelResilience.make({ retrySchedule: Schedule.recurs(1) }) },
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(
          result.result.events
            .filter((event) => event.type === "model.output.delta")
            .map((event) => event.text)
            .join(""),
        ).toBe("recovered")
      }),
    ),
  30_000,
)

test(
  "accepts steering while a TestModel execution is active",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "steer-read" })], {
              delay: Duration.millis(100),
            }),
            TestModel.text("steered"),
          ],
          (fixture, directory) =>
            Effect.scoped(
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem
                yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "fixture")
                const backend = yield* ExecutionBackend.Service
                const fiber = yield* Effect.forkScoped(
                  start(backend, { threadId: "thread-steer", turnId: "turn-steer", prompt: "start", startedAt: 1 }),
                )
                yield* fixture.awaitRequests(1)
                yield* backend.steer("turn-steer", "focus on the fixture", 2)
                const result = yield* Fiber.join(fiber)
                return { result, requests: yield* fixture.requests }
              }),
            ),
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(encodeJson(result.requests[0])).not.toContain("focus on the fixture")
        expect(encodeJson(result.requests[1]).match(/focus on the fixture/g)).toHaveLength(1)
      }),
    ),
  30_000,
)

test(
  "persists automatic compaction across backend restart and reuses compacted context",
  () =>
    runNative(
      Effect.gen(function* () {
        const usage = Response.Usage.make({
          inputTokens: { uncached: 200, total: 200, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        })
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-compaction-" })
            yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "sensitive fixture contents")
            const fixture = yield* TestModel.make([
              TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "compact-read" })], {
                usage,
              }),
              TestModel.text(
                "Goal: Finish the compacted run. The fixture was read. Continue with the durable checkpoint.",
              ),
              TestModel.text("compaction complete"),
            ])
            const filename = `${directory}/relay.db`
            const options = {
              filename,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection" as const,
              compaction: { contextWindow: 100, reserveTokens: 1, keepRecentTokens: 10 },
            }
            const input = {
              threadId: "thread-compaction",
              turnId: "turn-compaction",
              prompt: "read fixture.txt and finish",
              startedAt: 1,
            }
            const run = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
              provide(effect, RelayExecutionBackend.layer(options))
            const completed = yield* run(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                return yield* start(backend, input)
              }),
            )
            const database = new Database(filename, { readonly: true })
            const checkpoints = database
              .query("SELECT checkpoint_id, summary, turn FROM relay_agent_compactions WHERE execution_id = ?")
              .all("execution:turn-compaction") as ReadonlyArray<{
              checkpoint_id: string
              summary: string
              turn: number
            }>
            database.close()
            const reopened = yield* run(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const duplicate = yield* start(backend, input)
                return { duplicate, replay: yield* backend.replay(input.turnId) }
              }),
            )
            const verifyDatabase = new Database(filename, { readonly: true })
            const checkpointCount = verifyDatabase
              .query("SELECT count(*) AS count FROM relay_agent_compactions WHERE execution_id = ?")
              .get("execution:turn-compaction") as { count: number }
            verifyDatabase.close()
            return {
              completed,
              reopened,
              checkpoints,
              checkpointCount: checkpointCount.count,
              requests: yield* fixture.requests,
            }
          }),
        )
        expect(result.completed.status).toBe("completed")
        expect(result.checkpoints).toHaveLength(1)
        expect(result.checkpoints[0]?.checkpoint_id).toContain("compaction:execution:turn-compaction")
        expect(result.checkpoints[0]?.summary).toContain("Finish the compacted run")
        expect(result.checkpointCount).toBe(1)
        expect(result.reopened.duplicate.events).toEqual(result.reopened.replay.events)
        expect(result.requests).toHaveLength(3)
        expect(encodeJson(result.requests[1]?.prompt)).toContain("Summarize the conversation")
        expect(encodeJson(result.requests[2]?.prompt)).toContain("Finish the compacted run")
      }),
    ),
  60_000,
)

test(
  "cancels an in-flight model through Relay",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [TestModel.turn([TestModel.text("late")], { delay: Duration.seconds(5) })],
          (fixture) =>
            Effect.scoped(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const fiber = yield* Effect.forkScoped(
                  start(backend, { threadId: "thread-a", turnId: "turn-cancel", prompt: "wait", startedAt: 1 }),
                )
                yield* fixture.awaitRequests(1)
                const accepted = yield* backend.cancel("turn-cancel", 2)
                const completed = yield* Fiber.join(fiber)
                return { accepted, completed }
              }),
            ),
        )
        const result = yield* program
        expect(result.accepted.status).toBe("cancelled")
        expect(result.accepted.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
        expect(result.completed.status).toBe("cancelled")
        expect(result.completed.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
      }),
    ),
  30_000,
)

for (const answer of ["Approved", "Denied", "Always"] as const) {
  test(
    `resumes a durable permission wait after restart with ${answer} and no duplicate tool effects`,
    () =>
      runNative(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-permission-" })
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "permission fixture")
              const fixture = yield* TestModel.make([
                TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: `read-${answer}` })]),
                TestModel.text(`${answer} complete`),
              ])
              const options = {
                filename: `${directory}/relay.db`,
                workspace: directory,
                registration: fixture.registration,
                selection: fixture.selection,
                modelVariantPolicy: "fixed-selection" as const,
                permissionPolicy: { rules: [{ pattern: "read_file", level: "ask" as const }] },
              }
              const useBackend = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
                provide(effect, RelayExecutionBackend.layer(options))
              const input = {
                threadId: `thread-${answer}`,
                turnId: `turn-${answer}`,
                prompt: "read fixture",
                startedAt: 1,
              }
              const waiting = yield* useBackend(
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const started = yield* start(backend, input)
                  const inspection = yield* backend.inspect(input.turnId)
                  return { started, waits: inspection?.waits ?? [] }
                }),
              )
              expect(waiting.started.status).toBe("waiting")
              expect(waiting.waits).toHaveLength(1)
              const waitId = waiting.waits[0]!.id
              const completed = yield* useBackend(
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  yield* backend.resolvePermission(waitId, answer, 2, "test decision")
                  const resumed = yield* start(backend, input)
                  const duplicate = yield* start(backend, input)
                  const replay = yield* backend.replay(input.turnId)
                  return { resumed, duplicate, replay, approvals: yield* backend.listApprovals(input.turnId) }
                }),
              )
              return { ...completed, requests: yield* fixture.requests }
            }),
          )
          expect(result.resumed.status).toBe("completed")
          expect(result.duplicate.status).toBe("completed")
          expect(result.approvals).toEqual([])
          expect(result.requests).toHaveLength(2)
          expect(result.replay.events.filter((event) => event.type === "tool.result.received")).toHaveLength(
            answer === "Denied" ? 0 : 1,
          )
          expect(result.replay.events.map((event) => event.cursor)).toEqual(
            result.duplicate.events.map((event) => event.cursor),
          )
        }),
      ),
    60_000,
  )
}

test(
  "thread host entity wakes on a delivered promotion and invokes the registered promoter",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend([], (_fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const promoted: Array<readonly [string, number]> = []
            yield* backend.registerTurnPromoter!((threadId, generation) =>
              Effect.sync(() => {
                promoted.push([threadId, generation])
                return 1
              }),
            )
            yield* backend.wakeThreadHost!({
              threadId: "thread-host-native",
              generation: 1,
              queueRevision: 1,
              now: 3,
            })
            yield* backend.wakeThreadHost!({
              threadId: "thread-host-native",
              generation: 1,
              queueRevision: 1,
              now: 4,
            })
            yield* Effect.suspend(() =>
              promoted.length > 0
                ? Effect.void
                : Effect.fail(ExecutionBackend.BackendError.make({ message: "promoter not invoked yet" })),
            ).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 100 }))
            return promoted
          }),
        )
        const promoted = yield* program
        expect(promoted).toEqual([["thread-host-native", 1]])
      }),
    ),
  60_000,
)
