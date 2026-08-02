import { AiError, ModelRegistry, Response } from "@batonfx/core"
import { classifyFailure as classifyOpenAiFailure } from "@batonfx/providers/openai"
import { TestModel } from "@batonfx/test"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Duration, Effect, Fiber, FileSystem, Layer } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-layer"
const { runNative, encodeJson, testModelRegistration } = testSupport
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
          registration: testModelRegistration(registration?.(fixture) ?? fixture.registration),
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          ...layerOptions,
        }),
      )
    }),
  )
test(
  "fails a second classified context overflow after exactly one compacted replay",
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
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "overflow-twice-read" })]),
            TestModel.failure(overflow),
            TestModel.text("Goal: Retry once. The first request overflowed. Use one compacted replay."),
            TestModel.failure(overflow),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "overflow twice fixture")
              const backend = yield* ExecutionBackend.Service
              const execution = yield* start(backend, {
                threadId: "thread-overflow-twice",
                turnId: "turn-overflow-twice",
                prompt: "read fixture.txt and finish",
              })
              const database = new Database(`${directory}/execution.db`, { readonly: true })
              const checkpoint = database
                .query("SELECT count(*) AS count FROM relay_agent_compactions WHERE execution_id = ?")
                .get("execution:turn-overflow-twice") as { count: number }
              database.close()
              return { execution, checkpointCount: checkpoint.count, requests: yield* fixture.requests }
            }),
          {
            compaction: { contextWindow: 100_000, reserveTokens: 1, keepRecentTokens: 1 },
            registration: (fixture) => ({
              ...fixture.registration,
              classifyFailure: classifyOpenAiFailure,
            }),
          },
        )
        expect(result.execution.status).toBe("failed")
        expect(result.checkpointCount).toBe(1)
        expect(result.requests.map((request) => request.operation)).toEqual([
          "streamText",
          "streamText",
          "generateText",
          "streamText",
        ])
        expect(result.execution.events.filter((event) => event.type === "tool.result.received")).toHaveLength(1)
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
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "steer-read" })], {
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
                  start(backend, { threadId: "thread-steer", turnId: "turn-steer", prompt: "start" }),
                )
                yield* fixture.awaitRequests(1)
                const receipt = yield* backend.steer("turn-steer", "focus on the fixture", "steer-request-1")
                const retriedReceipt = yield* backend.steer("turn-steer", "focus on the fixture", "steer-request-1")
                const conflict = yield* Effect.flip(
                  backend.steer("turn-steer", "use a different fixture", "steer-request-1"),
                )
                const result = yield* Fiber.join(fiber)
                return { result, receipt, retriedReceipt, conflict, requests: yield* fixture.requests }
              }),
            ),
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(result.retriedReceipt).toEqual(result.receipt)
        expect(result.conflict).toBeInstanceOf(ExecutionBackend.BackendError)
        expect(result.conflict.message).toBe(
          "Steering idempotency identity was already used with a different semantic payload",
        )
        expect(result.conflict.message).not.toContain("steer-request-1")
        expect(encodeJson(result.requests[0])).not.toContain("focus on the fixture")
        expect(encodeJson(result.requests[1]).match(/focus on the fixture/g)).toHaveLength(1)
        expect(result.receipt.sequence).toBe(0)
        expect(result.receipt.steeringMessageId.endsWith(":steering:0")).toBe(true)
        const delivered = result.result.events.filter(
          (event) => event.type === "steering.delivered" && (event.data?.message_count as number) > 0,
        )
        expect(delivered).toHaveLength(1)
        expect(delivered[0]?.text).toBe("focus on the fixture")
        expect(delivered[0]?.data?.message_sequences).toEqual([result.receipt.sequence])
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
              TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "compact-read" })], {
                usage,
              }),
              TestModel.text(
                "Goal: Finish the compacted run. The fixture was read. Continue with the durable checkpoint.",
              ),
              TestModel.text("compaction complete"),
            ])
            const filename = `${directory}/execution.db`
            const options = {
              filename,
              workspace: directory,
              registration: testModelRegistration(fixture.registration),
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection" as const,
              compaction: { contextWindow: 100, reserveTokens: 1, keepRecentTokens: 10 },
            }
            const input = {
              threadId: "thread-compaction",
              turnId: "turn-compaction",
              prompt: "read fixture.txt and finish",
            }
            const run = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
              provide(effect, relayLayer(options))
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
        expect(result.requests.map((request) => request.operation)).toEqual([
          "streamText",
          "generateText",
          "streamText",
        ])
        expect(encodeJson(result.requests[1]?.prompt)).toContain("Summarize the conversation")
        expect(encodeJson(result.requests[1]?.prompt)).not.toContain("sensitive fixture contents")
        expect(encodeJson(result.requests[1]?.prompt)).not.toContain("compaction complete")
        expect(encodeJson(result.requests[2]?.prompt)).toContain("Finish the compacted run")
        expect(encodeJson(result.requests[2]?.prompt)).toContain("sensitive fixture contents")
        expect(encodeJson(result.reopened.replay.events)).toContain("sensitive fixture contents")
      }),
    ),
  60_000,
)
