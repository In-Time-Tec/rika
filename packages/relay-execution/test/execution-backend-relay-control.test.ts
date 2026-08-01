import { AiError, ModelRegistry, ModelResilience } from "@batonfx/core"
import { classifyFailure as classifyOpenAiFailure } from "@batonfx/providers/openai"
import { TestModel } from "@batonfx/test"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schedule } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"

import { createFanOut, start } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-layer"
const { executionModelRoute, runNative, encodeJson, decodeToolExecution } = testSupport
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
  "corrects unknown and malformed tool calls at the durable model boundary",
  () =>
    runNative(
      Effect.gen(function* () {
        const cases = [
          ["turn-unknown", "not_a_rika_tool", {}],
          ["turn-malformed", "read", { path: 42 }],
        ] as const
        yield* Effect.forEach(cases, ([turnId, name, params]) =>
          Effect.gen(function* () {
            const outcome = yield* withBackend(
              [TestModel.toolCall(name, params, { id: turnId }), TestModel.text("corrected")],
              (fixture) =>
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const result = yield* start(backend, { threadId: turnId, turnId, prompt: "call tool" })
                  return { result, requests: yield* fixture.requests }
                }),
            )
            expect(outcome.result.status).toBe("completed")
            expect(
              outcome.result.events
                .filter((event) => event.type === "model.cycle.completed")
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
        const childOutput = "CHILD_OK"
        const result = yield* withBackend(
          [TestModel.text("parent ready"), TestModel.text("CHILD_OK")],
          (_, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              yield* start(backend, {
                threadId: "thread-long-child",
                turnId: "turn-long-child-parent",
                prompt: "prepare fan-out",
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
                  schedule: Schedule.spaced("20 millis"),
                }),
              )
              const database = new Database(`${directory}/execution.db`, { readonly: true })
              const childExecutions = database
                .query<
                  { readonly id: string; readonly status: string; readonly agent_snapshot_json: string },
                  []
                >("select e.id as id, e.status as status, s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id = 'child:turn-long-child-parent:long-child'")
                .all()
              database.close()
              return { fanOut, childExecutions }
            }),
        )
        expect(result.fanOut?.state).toBe("satisfied")
        expect(result.childExecutions).toHaveLength(1)
        expect(result.childExecutions[0]).toMatchObject({
          id: "child:turn-long-child-parent:long-child",
          status: "completed",
        })
        expect(
          decodeToolExecution(result.childExecutions[0]?.agent_snapshot_json ?? "{}").tool_execution?.concurrency,
        ).toBe("unbounded")
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
            const main = yield* TestModel.make([TestModel.text("parent-main"), TestModel.text("child-main")], {
              provider: "main-provider",
              model: "main-model",
              registrationKey: "main",
            })
            const oracle = yield* TestModel.make([TestModel.text("child-oracle")], {
              provider: "oracle-provider",
              model: "oracle-model",
              registrationKey: "oracle",
            })
            const executionRoute: ExecutionRouteSnapshot.ExecutionRoutePin = {
              version: 1 as const,
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
                    schedule: Schedule.spaced("20 millis"),
                  }),
                )
                return {
                  fanOut,
                  mainRequests: yield* main.requests,
                  oracleRequests: yield* oracle.requests,
                }
              }),
              relayLayer({
                filename: `${directory}/execution.db`,
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
        expect(result.fanOut?.members.map((member) => member.output)).toEqual(["child-oracle", "child-main"])
        expect(result.mainRequests).toHaveLength(2)
        expect(result.oracleRequests).toHaveLength(1)
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
              })
              return { result, requests: yield* fixture.requests }
            }),
          { modelResilience: Effect.runSync(ModelResilience.make({ retrySchedule: Schedule.recurs(1) })) },
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(
          result.result.events
            .filter((event) => event.type === "model.cycle.completed")
            .map((event) => event.text)
            .join(""),
        ).toBe("recovered")
      }),
    ),
  30_000,
)
test(
  "durably compacts and replays one classified pre-output context overflow",
  () =>
    runNative(
      Effect.gen(function* () {
        const overflow = AiError.make({
          module: "openai",
          method: "streamText",
          reason: AiError.InvalidRequestError.make({ description: "maximum context length exceeded" }),
        })
        const result = yield* withBackend(
          [
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "overflow-read" })]),
            TestModel.failure(overflow),
            TestModel.text(
              "Goal: Recover the rejected request. The fixture was read. Replay from the compacted projection.",
            ),
            TestModel.text("recovered after compaction"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "durable overflow fixture")
              const backend = yield* ExecutionBackend.Service
              const execution = yield* start(backend, {
                threadId: "thread-overflow-recovery",
                turnId: "turn-overflow-recovery",
                prompt: "read fixture.txt and finish",
              })
              const database = new Database(`${directory}/execution.db`, { readonly: true })
              const checkpoints = database
                .query("SELECT checkpoint_id, summary FROM relay_agent_compactions WHERE execution_id = ?")
                .all("execution:turn-overflow-recovery") as ReadonlyArray<{ checkpoint_id: string; summary: string }>
              database.close()
              return { execution, checkpoints, requests: yield* fixture.requests }
            }),
          {
            compaction: { contextWindow: 100_000, reserveTokens: 1, keepRecentTokens: 1 },
            registration: (fixture) => ({
              ...fixture.registration,
              classifyFailure: classifyOpenAiFailure,
            }),
          },
        )
        expect(result.execution.status).toBe("completed")
        expect(result.checkpoints).toHaveLength(1)
        expect(result.checkpoints[0]?.summary).toContain("Recover the rejected request")
        expect(result.requests.map((request) => request.operation)).toEqual([
          "streamText",
          "streamText",
          "generateText",
          "streamText",
        ])
        expect(result.execution.events.filter((event) => event.type === "tool.result.received")).toHaveLength(1)
        expect(encodeJson(result.requests[3]?.prompt)).toContain("Recover the rejected request")
        expect(
          result.execution.events
            .filter((event) => event.type === "model.cycle.completed")
            .map((event) => event.text)
            .join(""),
        ).toBe("recovered after compaction")
      }),
    ),
  30_000,
)
