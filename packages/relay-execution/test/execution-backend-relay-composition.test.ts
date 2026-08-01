import { ModelRegistry } from "@batonfx/core"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionRequest from "@rika/product/execution-request"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

import { TestModel } from "@batonfx/test"
import { executionEventHistoryFor } from "@rika/configuration/profile-data-paths"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Cause, Duration, Effect, Fiber, FileSystem, Layer, Schedule } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"

import { start as startExecution } from "./current-execution-route"

import { layer as relayLayer } from "../src/relay/execution/relay-execution-layer"
import { fixture as testSupport } from "./execution-backend-relay-fixture"
import type { LayerOptions } from "../src/relay/execution/relay-execution-layer"
import Route from "../src/relay/execution/relay-execution-route"
import Configured from "../src/relay/execution/relay-execution-configured"
const { executionRoutePin } = Route
const { configuredExecutionModelRoutes, configuredWithPinnedRouteRegistration } = Configured
const { runNative } = testSupport
const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )
const recordingBackend = (
  starts: Array<ExecutionRequest.StartInput>,
  registrations?: Array<string>,
): ExecutionBackend.Interface =>
  ExecutionBackend.Service.of({
    ...(registrations === undefined
      ? {}
      : {
          registerModels: (values: ReadonlyArray<ModelRegistry.Registration>) =>
            Effect.sync(() => {
              registrations.push(...values.map((value) => value.registrationKey ?? ""))
            }),
        }),
    invokeChild: () => Effect.die("unused"),
    resolveInvocationSource: () => Effect.die("unused"),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: (input) =>
      Effect.sync(() => {
        starts.push(input)
        return { turnId: input.turnId, status: "completed" as const, events: [] }
      }),
    inspect: () => Effect.sync((): undefined => undefined),
    replay: () => Effect.die("unused"),
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  })

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
                  startExecution(backend, { threadId: "thread-a", turnId: "turn-cancel", prompt: "wait" }),
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
            yield* startExecution(backend, {
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

test("isolates a stale persisted route while healthy routes keep starting", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const route = executionRoutePin(SettingsDefaults.Defaults.defaults, "medium")
        const healthy = route.main
        const stale = {
          ...route.main,
          alias: "retired",
          registrationIdentity: modelRegistrationIdentity("retired-registration"),
          requestVariant: "retired-registration",
          providerConnection: {
            ...route.main.providerConnection,
            provider: "retired-provider",
            protocol: "retired-provider",
            apiKeyEnvironment: "RETIRED_API_KEY",
          },
        }
        const unavailable = [{ route: stale, message: "Missing RETIRED_API_KEY for retired-provider" }]
        expect(unavailable[0]?.route.alias).toBe("retired")
        expect(unavailable[0]?.route.registrationIdentity).toBe("retired-registration")
        expect(unavailable[0]?.message).toContain("RETIRED_API_KEY")
        const starts = new Array<ExecutionRequest.StartInput>()
        const backend = recordingBackend(starts)
        const isolated = yield* configuredWithPinnedRouteRegistration(backend, {
          registeredRoutes: [healthy],
          unavailable,
          registerPinnedRoutes: () => Effect.die("unavailable routes must not be registered"),
        })
        const input = {
          threadId: "thread",
          turnId: "healthy-turn",
          prompt: "healthy",
          executionRoute: {
            version: route.version,
            mode: route.mode,
            main: healthy,
            oracle: { ...healthy, role: "oracle" as const },
          },
        }
        expect((yield* isolated.start(input)).status).toBe("completed")
        const failed = yield* Effect.exit(
          isolated.start({
            ...input,
            turnId: "stale-turn",
            executionRoute: {
              version: route.version,
              mode: route.mode,
              main: stale,
              oracle: { ...stale, role: "oracle" as const },
            },
          }),
        )
        expect(starts.map((start) => start.turnId)).toEqual(["healthy-turn"])
        expect(failed._tag).toBe("Failure")
        if (failed._tag === "Failure") {
          expect(Cause.hasDies(failed.cause)).toBe(false)
          const failure = failed.cause.reasons.find(Cause.isFailReason)
          expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
            _tag: "ExecutionBackendError",
            message: expect.stringMatching(/retired.*RETIRED_API_KEY/),
          })
        }
      }),
    ),
  ))

test("resolves a legacy unavailable route to the current default when it starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = executionRoutePin(SettingsDefaults.Defaults.defaults, "medium")
      const legacyModel = {
        ...current.main,
        role: "main" as const,
        alias: "legacy-unavailable",
        model: "legacy-unavailable",
        registrationIdentity: modelRegistrationIdentity("legacy-unavailable"),
        requestVariant: "legacy-unavailable",
        providerConnection: {
          ...current.main.providerConnection,
          provider: "legacy-unavailable",
          protocol: "test",
          baseUrl: "test://legacy-unavailable",
          authentication: "none" as const,
        },
      }
      const legacy: ExecutionRouteSnapshot.ExecutionRoutePin = {
        version: 1,
        mode: "test",
        main: legacyModel,
        oracle: { ...legacyModel, role: "oracle" },
      }
      const starts = new Array<ExecutionRequest.StartInput>()
      const isolated = yield* configuredWithPinnedRouteRegistration(recordingBackend(starts), {
        registeredRoutes: configuredExecutionModelRoutes(current),
        unavailable: [],
        registerPinnedRoutes: () => Effect.succeed([]),
        resolveLegacyRoute: () => Effect.succeed({ executionRoute: current, registrations: [] }),
      })
      yield* isolated.start({
        threadId: "legacy-thread",
        turnId: "legacy-turn",
        prompt: "backfilled",
        executionRoute: legacy,
      })
      expect(starts).toHaveLength(1)
      expect(starts[0]?.executionRoute.mode).toBe("medium")
      expect(starts[0]?.executionRoute.main.alias).toBe(current.main.alias)
    }),
  ))

test("re-registers a cloned active route when interrupt-and-send starts it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cloned = executionRoutePin(SettingsDefaults.Defaults.defaults, "high")
      const starts = new Array<ExecutionRequest.StartInput>()
      const registrations = new Array<string>()
      const isolated = yield* configuredWithPinnedRouteRegistration(recordingBackend(starts, registrations), {
        registeredRoutes: [],
        unavailable: [],
        registerPinnedRoutes: (routes) =>
          Effect.sync(() => {
            registrations.push(...routes.map((route) => route.registrationIdentity))
            return []
          }),
      })
      yield* isolated.start({
        threadId: "interrupt-thread",
        turnId: "interrupt-successor",
        prompt: "continue",
        executionRoute: cloned,
      })
      expect(starts).toHaveLength(1)
      expect(registrations).toContain(cloned.main.registrationIdentity)
      expect(registrations).toContain(cloned.oracle.registrationIdentity)
    }),
  ))
