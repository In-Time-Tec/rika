import { ModelRegistry } from "@batonfx/core"

import { TestModel } from "@batonfx/test"
import { executionEventHistoryFor } from "@rika/configuration/profile-data-paths"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Duration, Effect, Fiber, FileSystem, Layer, Schedule } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-adapter"
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
                  start(backend, { threadId: "thread-a", turnId: "turn-cancel", prompt: "wait" }),
                )
                yield* fixture.awaitRequests(1)
                const accepted = yield* backend.cancel("turn-cancel")
                const completed = yield* Fiber.join(fiber)
                return { accepted, completed }
              }),
            ),
        )
        const result = yield* program
        expect(result.accepted.status).toBe("cancelled")
        expect(result.accepted.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
        expect(result.accepted.checkpoint?.cursor).toBe(
          result.accepted.events.findLast((event) => event.type === "execution.cancelled")?.cursor,
        )
        expect(result.completed.status).toBe("cancelled")
        expect(result.completed.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
      }),
    ),
  30_000,
)
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
test(
  "binds a clean data root to its event history store on first start",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend([TestModel.text("archived answer")], (_fixture, directory) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const backend = yield* ExecutionBackend.Service
            yield* start(backend, {
              threadId: "thread-history",
              turnId: "turn-history",
              prompt: "hello",
            })
            const history = executionEventHistoryFor(`${directory}/execution.db`)
            const database = new Database(`${directory}/execution.db`, { readonly: true })
            const bindings = database
              .query("SELECT store_identity, state FROM relay_event_history_bindings")
              .all() as ReadonlyArray<{ store_identity: string; state: string }>
            const manifests = database
              .query("SELECT count(*) AS count FROM relay_execution_event_archive_manifests")
              .get() as { count: number }
            const events = database.query("SELECT count(*) AS count FROM relay_execution_events").get() as {
              count: number
            }
            database.close()
            return {
              history,
              directoryExists: yield* fileSystem.exists(history),
              markerExists: yield* fileSystem.exists(`${history}/.relay-history-store`),
              bindings,
              manifests,
              events,
            }
          }),
        )
        const result = yield* program
        expect(result.history).toBe(
          `${result.history.slice(0, result.history.lastIndexOf("/"))}/execution-event-history`,
        )
        expect(result.directoryExists).toBe(true)
        expect(result.markerExists).toBe(true)
        expect(result.bindings).toHaveLength(1)
        expect(result.bindings[0]!.state).toBe("ready")
        expect(result.bindings[0]!.store_identity).toMatch(/^[0-9a-f]{64}$/)
        expect(result.manifests.count).toBe(0)
        expect(result.events.count).toBeGreaterThan(0)
      }),
    ),
  60_000,
)
