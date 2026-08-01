import { ModelRegistry } from "@batonfx/core"

import { TestModel } from "@batonfx/test"

import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-layer"
const { executionModelRoute, runNative, encodeJson } = testSupport
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
  "streams transient output deltas live while keeping replay on durable completions",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* withBackend(
          [TestModel.turn([TestModel.text("one "), TestModel.text("two "), TestModel.text("three")])],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const streamed: Array<ExecutionBackend.Event> = []
              const first = yield* start(backend, {
                threadId: "thread-a",
                turnId: "turn-a",
                prompt: "hello",
                onEvent: (event: ExecutionBackend.Event) => streamed.push(event),
              })
              const replay = yield* backend.replay("turn-a")
              return { first, replay, streamed }
            }),
        )
        const deltas = result.first.events.filter((event) => event.type === "model.output.delta")
        expect(deltas.length).toBeGreaterThanOrEqual(3)
        expect(deltas.map((event) => event.text)).toEqual(["one ", "two ", "three"])
        expect(deltas.every((event) => typeof event.data?.transient_index === "number")).toBe(true)
        expect(new Set(deltas.map((event) => event.sequence)).size).toBe(1)
        expect(result.streamed.map((event) => event.cursor)).toEqual(result.first.events.map((event) => event.cursor))
        expect(result.replay.events.some((event) => event.type === "model.output.delta")).toBe(false)
        const cycle = result.replay.events.find((event) => event.type === "model.cycle.completed")
        expect(cycle?.text).toBe("one two three")
        expect(result.first.checkpoint).toEqual(result.replay.checkpoint)
      }),
    ),
  30_000,
)
test(
  "provides the exact Relay invocation context to an additional tool without exposing its raw key",
  () =>
    runNative(
      Effect.gen(function* () {
        const observed: Array<ToolInvocation.Value> = []
        const probe = Tool.make("invocation_probe", {
          description: "Observe invocation context",
          parameters: Schema.Struct({ value: Schema.String }),
          success: Schema.String,
        })
        const additionalToolkit = Toolkit.make(probe)
        const result = yield* withBackend(
          [
            TestModel.turn([
              TestModel.toolCall("invocation_probe", { value: "first" }, { id: "probe-first" }),
              TestModel.toolCall("invocation_probe", { value: "second" }, { id: "probe-second" }),
            ]),
            TestModel.text("done"),
          ],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              return yield* start(backend, {
                threadId: "thread-invocation",
                turnId: "turn-invocation",
                prompt: "probe",
              })
            }),
          {
            additionalToolkit,
            additionalHandlerLayer: additionalToolkit.toLayer({
              invocation_probe: () =>
                Effect.gen(function* () {
                  const invocation = yield* ToolInvocation.ToolInvocation
                  observed.push(invocation)
                  yield* Effect.yieldNow
                  expect((yield* ToolInvocation.ToolInvocation).callId).toBe(invocation.callId)
                  return invocation.idempotencyKeyDigest
                }) as unknown as Effect.Effect<string>,
            }),
          },
        )
        expect(result.status).toBe("completed")
        expect(observed).toHaveLength(2)
        expect(observed.map((invocation) => invocation.callId).toSorted()).toEqual(["probe-first", "probe-second"])
        expect(observed.every((invocation) => invocation.executionId === "execution:turn-invocation")).toBe(true)
        expect(observed.every((invocation) => invocation.toolName === "invocation_probe")).toBe(true)
        expect(observed.map((invocation) => invocation.eventSequence).toSorted()).toEqual([6, 7])
        expect(observed.every((invocation) => typeof invocation.createdAt === "number")).toBe(true)
        expect(observed.every((invocation) => /^[a-f0-9]{64}$/.test(invocation.idempotencyKeyDigest))).toBe(true)
        expect(observed[0]?.idempotencyKeyDigest).not.toBe(observed[1]?.idempotencyKeyDigest)
        expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(observed)).not.toContain("tool:")
      }),
    ),
  30_000,
)
test(
  "delivers image attachments to Baton as inline data URLs",
  () =>
    runNative(
      withBackend([TestModel.text("image received")], (fixture) =>
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          yield* start(backend, {
            threadId: "thread-image",
            turnId: "turn-image",
            prompt: "inspect [Image #1]",
            promptParts: [
              { type: "text", text: "inspect " },
              { type: "image", mediaType: "image/png", data: "AQID", filename: "shot.png" },
              { type: "text", text: " closely" },
            ],
          })
          const requests = yield* fixture.requests
          const parts = requests[0]?.prompt.content.flatMap((message) =>
            message.role === "user" && Array.isArray(message.content) ? message.content : [],
          )
          expect(parts).toMatchObject([
            { type: "text", text: "inspect " },
            {
              type: "file",
              mediaType: "image/png",
              data: new URL("data:image/png;base64,AQID"),
              fileName: "shot.png",
            },
            { type: "text", text: " closely" },
          ])
        }),
      ),
    ),
  30_000,
)
test(
  "submits adjacent text parts to Baton as one text block",
  () =>
    runNative(
      withBackend(
        [TestModel.text("first answer"), TestModel.text("second answer")],
        (fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const first = yield* start(backend, {
              threadId: "thread-text-parts",
              turnId: "turn-text-parts-1",
              prompt: "stash changes please\n\n<resolved-context>\nguidance\n</resolved-context>",
              promptParts: [
                { type: "text", text: "stash changes please" },
                { type: "text", text: "\n\n<resolved-context>\nguidance\n</resolved-context>" },
              ],
            })
            const second = yield* start(backend, {
              threadId: "thread-text-parts",
              turnId: "turn-text-parts-2",
              prompt: "continue please",
            })
            expect(first.status).toBe("completed")
            expect(second.status).toBe("completed")
            const requests = yield* fixture.requests
            const userContents = requests[0]?.prompt.content.flatMap((message) =>
              message.role === "user" ? [message.content] : [],
            )
            expect(userContents).toHaveLength(1)
            const parts = Array.isArray(userContents?.[0]) ? userContents[0] : []
            expect(parts.filter((part: { type: string }) => part.type === "text")).toHaveLength(1)
            expect(parts[0]).toMatchObject({
              type: "text",
              text: "stash changes please\n\n<resolved-context>\nguidance\n</resolved-context>",
            })
          }),
        { compaction: { contextWindow: 1_000_000, reserveTokens: 100, keepRecentTokens: 100 } },
      ),
    ),
  30_000,
)
test(
  "rejects malformed inline images before the model request",
  () =>
    runNative(
      withBackend([TestModel.text("unused")], (fixture) =>
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const result = yield* start(backend, {
            threadId: "thread-malformed-image",
            turnId: "turn-malformed-image",
            prompt: "inspect [Image #1]",
            promptParts: [{ type: "image", mediaType: "image/png", data: "not-base64", filename: "shot.png" }],
          })
          expect(result.status).toBe("failed")
          expect(yield* fixture.requests).toHaveLength(0)
        }),
      ),
    ),
  30_000,
)
test(
  "delivers inline image data through a dynamically registered model",
  () =>
    runNative(
      withBackend(
        [TestModel.text("unused")],
        (fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const executionRoute: ExecutionBackend.ExecutionRoutePin = {
              version: 1 as const,
              mode: "test",
              main: executionModelRoute("main", fixture.selection),
              oracle: executionModelRoute("oracle", fixture.selection),
            }
            const result = yield* start(backend, {
              threadId: "thread-dynamic-image",
              turnId: "turn-dynamic-image",
              prompt: "inspect image",
              promptParts: [{ type: "image", mediaType: "image/png", data: "AQID", filename: "shot.png" }],
              executionRoute,
            })
            const requests = yield* fixture.requests
            const parts = requests[0]?.prompt.content.flatMap((message) =>
              message.role === "user" && Array.isArray(message.content) ? message.content : [],
            )
            expect(result.events.filter((event) => event.type === "execution.failed")).toEqual([])
            expect(result.status, encodeJson(result.events)).toBe("completed")
            expect(parts).toMatchObject([
              {
                type: "file",
                mediaType: "image/png",
                data: new URL("data:image/png;base64,AQID"),
                fileName: "shot.png",
              },
            ])
          }),
        {
          modelVariantPolicy: "registration-key",
          registration: (fixture) => ({ ...fixture.registration, registrationKey: "main" }),
        },
      ),
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
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "read-1" })]),
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
  "persists actionable tool failures and returns them to the next model turn",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.turn([TestModel.toolCall("read", { path: "missing.txt" }, { id: "missing-read" })]),
            TestModel.text("used recovery guidance"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const result = yield* start(backend, {
                threadId: "thread-tool-failure",
                turnId: "turn-tool-failure",
                prompt: "read missing.txt",
              })
              const stored = yield* Effect.acquireUseRelease(
                Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
                (database) =>
                  Effect.sync(() =>
                    database
                      .query<
                        { readonly error: string | null; readonly output_json: string },
                        [string]
                      >("select error, output_json from relay_tool_results where tool_call_id = ?")
                      .get("missing-read"),
                  ),
                (connection) => Effect.sync(() => connection.close()),
              )
              return { result, requests: yield* fixture.requests, stored }
            }),
        )
        const result = yield* program
        const guidance =
          "File not found: missing.txt. The call did not change state. Next action: Search for the file or call read with a corrected path."
        expect(result.result.status).toBe("completed")
        expect(result.stored).toEqual({ error: `ToolError: ${guidance}`, output_json: "null" })
        expect(encodeJson(result.requests[1])).toContain(guidance)
        expect(encodeJson(result.requests[1])).toContain("missing-read")
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
            TestModel.toolCall("grep", { pattern: "fixture", regex: false }, { id: originalCallId }),
            TestModel.text("first tool turn complete"),
            TestModel.toolCall("grep", { pattern: "fixture", regex: false }, { id: originalCallId }),
            TestModel.text("second tool turn complete"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const first = yield* start(backend, {
                threadId: "thread-reused-call-id",
                turnId: "first-reused-call-id",
                prompt: "first",
              })
              const second = yield* start(backend, {
                threadId: "thread-reused-call-id",
                turnId: "second-reused-call-id",
                prompt: "second",
              })
              const calls = yield* Effect.acquireUseRelease(
                Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
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
        expect(result.calls.map((call) => call.id)).toEqual([originalCallId, originalCallId])
        expect(new Set(result.calls.map((call) => call.execution_id)).size).toBe(2)
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
