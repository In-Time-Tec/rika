import { ModelRegistry } from "@batonfx/core"

import { TestModel } from "@batonfx/test"

import { expect, test } from "vitest"

import { Effect, FileSystem, Layer } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"

import { start } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-layer"
const { runNative } = testSupport
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
  "completes idempotently and replays from a cursor",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend([TestModel.text("deterministic answer")], (fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const streamed: Array<ExecutionEvent.Event> = []
            const input = {
              threadId: "thread-a",
              turnId: "turn-a",
              prompt: "hello",
              onEvent: (event: ExecutionEvent.Event) => streamed.push(event),
            }
            const first = yield* start(backend, input)
            const { onEvent: _onEvent, ...duplicateInput } = input
            const duplicate = yield* start(backend, duplicateInput)
            const replay = yield* backend.replay(input.turnId)
            const cursor = replay.events.at(1)?.cursor
            const after = yield* backend.replay(input.turnId, cursor)
            const followed = yield* backend.follow!(input.turnId, first.checkpoint)
            const source = yield* backend.resolveInvocationSource("execution:turn-a")
            return {
              first,
              duplicate,
              replay,
              after,
              followed,
              source,
              cursor,
              streamed,
              requests: yield* fixture.requests,
            }
          }),
        )
        const result = yield* program
        expect(result.first.status).toBe("completed")
        expect(result.first.events.map((event) => event.type)).toContain("model.output.completed")
        expect(result.streamed).toEqual([...result.first.events])
        const durableCursors = result.first.events
          .filter((event) => event.data?.transient_index === undefined)
          .map((event) => event.cursor)
        expect(result.duplicate.events.map((event) => event.cursor)).toEqual(durableCursors)
        expect(result.replay.events.map((event) => event.cursor)).toEqual(durableCursors)
        expect(result.replay.events.every((event) => event.executionId === "execution:turn-a")).toBe(true)
        expect(new Set(result.replay.events.map((event) => event.cursor)).size).toBe(result.replay.events.length)
        expect(result.after.events.map((event) => event.cursor)).toEqual(
          result.replay.events
            .slice(result.replay.events.findIndex((event) => event.cursor === result.cursor) + 1)
            .map((event) => event.cursor),
        )
        expect(result.first.checkpoint).toEqual(result.replay.checkpoint)
        expect(result.followed.events).toEqual([])
        expect(result.followed.checkpoint).toEqual(result.first.checkpoint)
        expect(result.source).toMatchObject({
          rootTurnId: "turn-a",
          threadId: "thread-a",
          callerProfile: "Root",
          threadCreationDepth: 0,
        })
        expect(result.requests).toHaveLength(1)
      }),
    ),
  30_000,
)
