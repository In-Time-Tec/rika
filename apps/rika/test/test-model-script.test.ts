import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as BehaviorMode from "@rika/configuration/behavior-mode"
import * as ModelRoute from "@rika/configuration/model-route"
import * as ModelRouteLabel from "@rika/configuration/model-route-label"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import { expect, test } from "vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { ModelRegistry } from "@rika/relay-execution/model-provider-runtime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { Cause, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { productLayer, Service } from "@rika/product/product-operation-service"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ThreadToolService from "@rika/product/thread-tool-service"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ViewState from "@rika/terminal/terminal-state"
import type { Model } from "@rika/terminal/terminal-state"
import { Surface } from "@rika/terminal/opentui-surface"
import {
  configuredBackendLayer,
  executionModelRoutes,
  executionRoutePin,
  modelRoutesForExecution,
  productionCompaction,
  resolveExecutionRouteForSettings,
  resolveExecutionWorkspace,
  validateWebSearchProviders,
  persistedModelRoutesForStartup,
  persistedTitleModelRoutesForStartup,
  withPinnedRouteRegistration,
} from "../src/resident-product"
import {
  buildTestModelScript,
  makeReloadingTestModel,
  parseTestModelScript,
} from "@rika/relay-execution/scripted-model-runtime"
import { withClientWorkspace } from "../src/interactive/process/interactive-process"
import { bedrockAuthRefreshTestLayer } from "@rika/relay-execution/model-provider-runtime"
import { modelRoutePlan, Service as ModelProviderRuntime } from "@rika/relay-execution/model-provider-runtime"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

const distinctModelRoutes = (routes: ReadonlyArray<ModelRouteResolution.ResolvedModelRoute>) =>
  routes.filter(
    (route, index, all) =>
      all.findIndex(
        (candidate) => modelRoutePlan(candidate).registrationKey === modelRoutePlan(route).registrationKey,
      ) === index,
  )

const httpRoute = (route: ModelRouteResolution.ResolvedModelRoute) => {
  if (route.providerConnection.protocol === "amazon-bedrock") throw new Error("Expected an HTTP model route")
  return route as ModelRouteResolution.ResolvedModelRoute & {
    readonly providerConnection: ModelRoute.ModelRoute.HttpProviderConnection
  }
}

test("rejects web search provider IDs that are not installed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateWebSearchProviders({ custom: Redacted.make("secret") }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("Unknown web search provider 'custom'")
    }),
  ))

const modelRouteDisplayLabel = (route: ModelRouteResolution.ResolvedModelRoute) => {
  const [provider, version, ...name] = route.model.split("-")
  const modelName = name.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ")
  return `${provider?.toUpperCase()}-${version} ${modelName} ${route.effort}`
}

const recordingBackend = (starts: Array<ExecutionRequest.StartInput>, registrations?: Array<string>) =>
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

class RouteOperationError extends Schema.TaggedErrorClass<RouteOperationError>()("OperationError", {
  message: Schema.String,
}) {}

const withBunServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scopedWith((scope) =>
    Layer.buildWithScope(BunServices.layer, scope).pipe(
      Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
    ),
  )

test("uses production compaction defaults and route overrides", () => {
  expect(productionCompaction()).toEqual({
    contextWindow: 1_050_000,
    reserveTokens: 128_000,
    keepRecentTokens: 32_000,
  })
  expect(
    productionCompaction({ compaction: { contextWindow: 192_000, reserveTokens: 32_000, keepRecentTokens: 16_000 } }),
  ).toEqual({
    contextWindow: 192_000,
    reserveTokens: 32_000,
    keepRecentTokens: 16_000,
  })
})

test("content-addresses non-secret model execution semantics deterministically", () => {
  const route = httpRoute(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "high", "oracle"))
  const key = modelRoutePlan(route).registrationKey
  expect(key).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(modelRoutePlan(route).registrationKey).toBe(key)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}/` },
    }).registrationKey,
  ).toBe(key)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}#primary` },
    }).registrationKey,
  ).toBe(key)
  const firstQuery = modelRoutePlan({
    ...route,
    providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}/?tenant=first` },
  }).registrationKey
  const secondQuery = modelRoutePlan({
    ...route,
    providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}?tenant=second` },
  }).registrationKey
  expect(firstQuery).not.toBe(secondQuery)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: {
        ...route.providerConnection,
        baseUrl: `${route.providerConnection.baseUrl}?tenant=first#ignored`,
      },
    }).registrationKey,
  ).toBe(firstQuery)
  const changes = [
    { ...route, providerConnection: { ...route.providerConnection, protocol: "anthropic" as const } },
    { ...route, providerConnection: { ...route.providerConnection, baseUrl: "https://models.example.test/v1" } },
    { ...route, model: "claude-opus-4-8" },
    { ...route, effort: "xhigh" as const },
    { ...route, fast: true },
    { ...route, options: { ...route.options, max_tokens: 64_000 } },
    { ...route, options: { ...route.options, service_tier: "priority" } },
  ]
  for (const changed of changes) expect(modelRoutePlan(changed).registrationKey).not.toBe(key)
  expect(JSON.stringify(modelRoutePlan(route))).not.toContain("API_KEY_VALUE")
  expect(modelRoutePlan(route).selection.registrationKey).toBe(key)
  expect(executionRoutePin(SettingsDefaults.Defaults.defaults, "high").oracle.providerOptions).toEqual(
    modelRoutePlan(route).options,
  )
  expect(executionRoutePin(SettingsDefaults.Defaults.defaults, "medium").tokenBudget).toBeUndefined()
  const settings = {
    ...SettingsDefaults.Defaults.defaults,
    compaction: { summaryModel: { alias: "terra", effort: "medium" as const } },
  }
  expect(executionRoutePin(settings, "medium").compactionSummary).toMatchObject({
    role: "compaction",
    alias: "terra",
    model: "gpt-5.6-terra",
  })
})

test("pins GPT 5.6 routes to each mode's configured effort and selected fast tier", () => {
  const modes = ["low", "medium", "high", "ultra"] as const
  for (const mode of modes) {
    for (const fastMode of [false, true]) {
      const route = executionRoutePin(SettingsDefaults.Defaults.defaults, mode, { fastMode })
      for (const selected of [route.main, route.oracle, route.title!]) {
        expect(selected.model).toMatch(/^gpt-5\.6-/)
        expect(selected.providerConnection.protocol).toBe("openai")
      }
      expect(route.main.providerOptions).toMatchObject({
        reasoning: { effort: SettingsDefaults.Defaults.defaults.modes[mode].main.effort },
      })
      expect(route.oracle.providerOptions).toMatchObject({
        reasoning: { effort: SettingsDefaults.Defaults.defaults.modes[mode].oracle.effort },
      })
      expect(route.main.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.oracle.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.title).toMatchObject({
        role: "title",
        alias: "luna",
        model: "gpt-5.6-luna",
        providerConnection: { protocol: "openai" },
        effort: "low",
        fast: false,
        providerOptions: { reasoning: { effort: "low" } },
      })
    }
  }
})

test("pins aliases, variants, candidates, specialists, titles, and summaries as one admission snapshot", () => {
  const settings: SettingsDefaults.ConfigurationSettings = {
    ...SettingsDefaults.Defaults.defaults,
    providers: {
      ...SettingsDefaults.Defaults.defaults.providers,
      openai: {
        ...SettingsDefaults.Defaults.providerDefaults.openai,
        baseUrl: "https://models.example.test/v1?tenant=admission",
        apiKeyEnv: "ADMISSION_API_KEY",
      },
    },
  }
  const resolved = modelRoutesForExecution(settings, "high", { fastMode: true })
  expect(resolved.map((route) => route.alias)).toEqual([
    "sol",
    "sol",
    "luna",
    "sol",
    "sol",
    "sol",
    "sol",
    "sol",
    "sol",
    "sol",
  ])
  expect(resolved.map((route) => route.model)).toEqual(resolved.map((route) => route.candidates[0]))

  const pin = executionRoutePin(settings, "high", { fastMode: true })
  expect(executionModelRoutes(pin).map((route) => route.role)).toEqual(["main", "oracle", "title", "compaction"])
  expect(pin).toMatchObject({
    mode: "high",
    main: { alias: "sol", effort: "medium", fast: true },
    oracle: { alias: "sol", effort: "high", fast: true },
    title: { alias: "luna", effort: "low", fast: false },
    compactionSummary: { alias: "sol", effort: "xhigh", fast: false },
  })
  for (const route of executionModelRoutes(pin)) {
    expect(route.providerConnection.baseUrl).toBe("https://models.example.test/v1?tenant=admission")
    expect(route.providerConnection.apiKeyEnvironment).toBe("ADMISSION_API_KEY")
    expect(route.requestVariant).toBe(route.registrationIdentity)
    expect(JSON.stringify(route)).not.toContain("secret")
  }
  expect(pin.main.providerOptions).toMatchObject({ reasoning: { effort: "medium" }, service_tier: "priority" })
  expect(pin.oracle.providerOptions).toMatchObject({ reasoning: { effort: "high" }, service_tier: "priority" })
  expect(pin.title?.providerOptions).not.toHaveProperty("service_tier")
  expect(pin.compactionSummary?.providerOptions).not.toHaveProperty("service_tier")
})

test("fails an unavailable tuned route through the typed error channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings: SettingsDefaults.ConfigurationSettings = {
        ...SettingsDefaults.Defaults.defaults,
        modes: {
          ...SettingsDefaults.Defaults.defaults.modes,
          low: {
            ...SettingsDefaults.Defaults.defaults.modes.low,
            main: { alias: "fable", effort: "low" },
          },
        },
      }
      const result = yield* Effect.exit(resolveExecutionRouteForSettings(settings, "low", { fastMode: true }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(Cause.hasDies(result.cause)).toBe(false)
        const failure = result.cause.reasons.find(Cause.isFailReason)
        expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
          _tag: "ModelRouteError",
          message: expect.stringContaining("Mode low main requests unavailable fable/low/fast variant"),
        })
      }
    }),
  ))

test("surfaces an unavailable tuned route as an interactive execution failure", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Deferred.make<InteractiveSession>()
        const release = yield* Deferred.make<void>()
        const events = new Array<InteractiveEvent>()
        const settings: SettingsDefaults.ConfigurationSettings = {
          ...SettingsDefaults.Defaults.defaults,
          modes: {
            ...SettingsDefaults.Defaults.defaults.modes,
            low: {
              ...SettingsDefaults.Defaults.defaults.modes.low,
              main: { alias: "fable", effort: "low" },
            },
          },
        }
        const operationLayer = productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, recordingBackend([])),
          resolveExecutionRoute: (mode, tuning) =>
            resolveExecutionRouteForSettings(settings, mode, tuning).pipe(
              Effect.map((resolved) => resolved.executionRoute),
              Effect.mapError((error) => RouteOperationError.make({ message: error.message })),
            ),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("route-failure-thread")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("route-failure-turn")),
          interactive: (_, session) =>
            Deferred.succeed(sessions, session).pipe(Effect.andThen(Deferred.await(release))),
        })
        const operation = Context.get(yield* Layer.buildWithScope(operationLayer, yield* Effect.scope), Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(sessions)
        const feed = yield* Effect.forkChild(
          session.events((event) => {
            events.push(event)
          }),
        )
        yield* Effect.yieldNow
        yield* session.submit("unavailable", "low", undefined, { fastMode: true })
        while (!events.some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
        const failed = events.find((event) => event._tag === "ExecutionFailed")
        expect(failed).toMatchObject({
          _tag: "ExecutionFailed",
          message: expect.stringContaining("Mode low main requests unavailable fable/low/fast variant"),
        })
        yield* Fiber.interrupt(feed)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(operationFiber)
      }),
    ),
  ))

test("renders every default mode route in the mode picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const modes = Object.keys(SettingsDefaults.Defaults.defaults.modes) as Array<BehaviorMode.ModeId>
        const setup = yield* Effect.acquireRelease(
          Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
          (value) => Effect.sync(() => value.renderer.destroy()),
        )
        const surface = yield* Effect.acquireRelease(
          Effect.sync(
            () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
          ),
          (value) => Effect.sync(() => value.destroy()),
        )
        for (const mode of modes) {
          surface.update({
            ...ViewState.initial("/workspace", mode),
            modePicker: { open: true, selected: modes.indexOf(mode) },
          })
          yield* Effect.tryPromise(() => setup.flush())
          yield* Effect.tryPromise(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toContain(
            `Oracle: ${modelRouteDisplayLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "oracle"))}`,
          )
          expect(frame).toContain(
            `Agent:  ${modelRouteDisplayLabel(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, mode, "main"))}`,
          )
        }
      }),
    ),
  ))

test("keeps registrations distinct by the exact Baton registry tuple", () => {
  const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "high", "oracle")
  const second = { ...route, fast: true }
  expect(modelRoutePlan(second).registrationKey).not.toBe(modelRoutePlan(route).registrationKey)
  expect(distinctModelRoutes([route, second, route])).toEqual([route, second])
})

test("sends each client's workspace to the resident service", () => {
  const interactive = {
    _tag: "Interactive" as const,
    prompt: [],
    ephemeral: false,
  }
  expect(withClientWorkspace(interactive, "/client-a")).toEqual({
    ...interactive,
    clientWorkspace: "/client-a",
    workspace: "/client-a",
  })
  expect(withClientWorkspace({ ...interactive, workspace: "/explicit" }, "/client-b")).toEqual({
    ...interactive,
    clientWorkspace: "/client-b",
    workspace: "/explicit",
  })
  expect(withClientWorkspace({ _tag: "Config", action: "list" }, "/client-c")).toEqual({
    _tag: "Config",
    action: "list",
    clientWorkspace: "/client-c",
  })
  expect(withClientWorkspace({ _tag: "Auth", action: "status", provider: "openai" }, "/client-auth")).toEqual({
    _tag: "Auth",
    action: "status",
    provider: "openai",
    clientWorkspace: "/client-auth",
  })
  expect(withClientWorkspace({ _tag: "Thread", action: "new" }, "/client-d")).toEqual({
    _tag: "Thread",
    action: "new",
    clientWorkspace: "/client-d",
  })
  expect(
    withClientWorkspace(
      { _tag: "Workflow", action: "start", name: "delivery", runId: "delivery-1" },
      "/client-workflow",
    ),
  ).toEqual({
    _tag: "Workflow",
    action: "start",
    name: "delivery",
    runId: "delivery-1",
    clientWorkspace: "/client-workflow",
  })
})

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
        const isolated = yield* withPinnedRouteRegistration(backend, {
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

test("builds the configured backend with duplicate persisted routes and one unavailable route", () =>
  Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-stale-route-startup-" })
          const productDatabase = Database.layer(path.join(root, "rika.db"))
          const productDatabaseContext = yield* Layer.buildWithScope(
            productDatabase.pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const productDatabaseLayer = Layer.succeedContext(productDatabaseContext)
          const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabaseLayer))
          const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(productDatabaseLayer))
          const settings: SettingsDefaults.ConfigurationSettings = {
            ...SettingsDefaults.Defaults.defaults,
            providers: {
              ...SettingsDefaults.Defaults.defaults.providers,
              openai: {
                protocol: "openai",
                baseUrl: SettingsDefaults.Defaults.providerDefaults.openai.baseUrl,
              },
            },
          }
          const pinned = executionRoutePin(settings, "medium")
          const restored = {
            ...pinned.main,
            registrationIdentity: modelRegistrationIdentity("restored-startup"),
            requestVariant: "restored-startup",
          }
          const stale = {
            ...pinned.main,
            alias: "retired-startup",
            registrationIdentity: modelRegistrationIdentity("retired-startup"),
            requestVariant: "retired-startup",
            providerConnection: {
              ...pinned.main.providerConnection,
              provider: "retired-startup",
              protocol: "retired-startup",
              apiKeyEnvironment: "RETIRED_STARTUP_API_KEY",
            },
          }
          const auth = OpenAiAuth.Service.of({
            loginBrowser: () => Effect.die("unused"),
            loginDevice: Effect.die("unused"),
            status: Effect.succeed({ _tag: "Unauthenticated" }),
            logout: Effect.die("unused"),
            acquire: Effect.die("unused"),
            refreshRejected: () => Effect.die("unused"),
          })
          const providerLayer = ModelProviderRuntime.layer.pipe(
            Layer.provide(Layer.succeed(OpenAiAuth.Service, auth)),
            Layer.provide(bedrockAuthRefreshTestLayer({ run: () => Effect.void })),
          )
          const context = yield* Layer.buildWithScope(
            configuredBackendLayer({
              filename: path.join(root, "execution.db"),
              workspace: "/work",
              repositoryLayer,
              turnRepositoryLayer,
              transcriptRepositoryLayer: TranscriptRepository.memoryLayer,
              threadSearchRepositoryLayer: ThreadSearchRepository.memoryLayer,
              threadInteractionRepositoryLayer: ThreadInteractionRepository.memoryLayer(),
              settings,
              persistedModelRoutes: [restored, restored, stale],
              threadToolGateway: yield* ThreadToolService.makeGateway,
            }).pipe(Layer.provide(providerLayer)),
            yield* Effect.scope,
          )
          const backend = Context.get(context, ExecutionBackend.Service)
          const failed = yield* Effect.exit(
            backend.start({
              threadId: "stale-thread",
              turnId: "stale-startup-turn",
              prompt: "stale",
              executionRoute: {
                version: pinned.version,
                mode: "medium",
                main: stale,
                oracle: { ...stale, role: "oracle" },
              },
            }),
          )
          expect(failed._tag).toBe("Failure")
          if (failed._tag === "Failure") {
            expect(Cause.hasDies(failed.cause)).toBe(false)
            const failure = failed.cause.reasons.find(Cause.isFailReason)
            expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
              _tag: "ExecutionBackendError",
              message: expect.stringMatching(/retired-startup.*unavailable/),
            })
          }
        }),
      ),
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
      const isolated = yield* withPinnedRouteRegistration(recordingBackend(starts), {
        registeredRoutes: executionModelRoutes(current),
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
      const isolated = yield* withPinnedRouteRegistration(recordingBackend(starts, registrations), {
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

test("restores every pinned role from a nonterminal turn into the restart registration set", () => {
  const route = executionRoutePin(SettingsDefaults.Defaults.defaults, "high")
  const owner: Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
    id: Turn.TurnId.make("review-owner"),
    threadId: "review-thread" as Turn.AgentExecutionTurn["threadId"],
    prompt: "Review workspace changes",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    status: "running",
    stopIntent: "none",
    executionRoute: {
      ...route,
      main: { ...route.main, registrationIdentity: modelRegistrationIdentity("workspace-main") },
      oracle: { ...route.oracle, registrationIdentity: modelRegistrationIdentity("workspace-oracle") },
    },
    reviewFanOutId: "review:review-owner",
    createdAt: 1,
    updatedAt: 2,
  }
  expect(persistedModelRoutesForStartup([owner]).map((candidate) => candidate.registrationIdentity)).toEqual([
    "workspace-main",
    "workspace-oracle",
    route.title!.registrationIdentity,
    route.compactionSummary!.registrationIdentity,
  ])
  const titleOwner: Turn.AgentExecutionTurn = {
    ...owner,
    id: Turn.TurnId.make("completed-title-owner"),
    status: "completed",
    executionRoute: {
      ...route,
      title: { ...route.title!, registrationIdentity: modelRegistrationIdentity("completed-title-route") },
    },
  }
  expect(
    [...persistedModelRoutesForStartup([owner]), titleOwner.executionRoute.title!].map(
      (candidate) => candidate.registrationIdentity,
    ),
  ).toContain("completed-title-route")
})

test("loads title model pins from completed turn rows for restart registration", () =>
  Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-title-routes-" })
          const databaseContext = yield* Layer.buildWithScope(
            Database.layer(path.join(root, "rika.db")).pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const databaseLayer = Layer.succeedContext(databaseContext)
          const repositories = yield* Layer.buildWithScope(
            Layer.merge(
              ThreadRepository.layer.pipe(Layer.provide(databaseLayer)),
              TurnRepository.layer.pipe(Layer.provide(databaseLayer)),
            ),
            yield* Effect.scope,
          )
          const route = executionRoutePin(SettingsDefaults.Defaults.defaults, "medium")
          yield* Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const thread = yield* threads.create({
              id: Thread.ThreadId.make("title-restart-thread"),
              workspace: "/work",
              title: "Seed",
              now: 1,
            })
            const turn = yield* turns.createForSubmission({
              id: Turn.TurnId.make("title-restart-turn"),
              threadId: thread.id,
              prompt: "title me",
              executionRoute: {
                ...route,
                title: {
                  ...route.title!,
                  registrationIdentity: modelRegistrationIdentity("durable-title-registration"),
                },
              },
              queueCapacity: 128,
              now: 1,
            })
            yield* turns.setStatus(turn.id, "completed", undefined, 2)
          }).pipe(Effect.provide(repositories))
          const titleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(Effect.provide(databaseContext))
          expect(titleRoutes.map((candidate) => candidate.registrationIdentity)).toContain("durable-title-registration")
        }),
      ),
    ),
  ))

test("uses the owning thread workspace for durable title executions", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = Layer.merge(ThreadRepository.memoryLayer(), TurnRepository.memoryLayer())
        const repositoryContext = yield* Layer.build(repositories)
        const repositoryLayer = Layer.succeedContext(repositoryContext)
        const threads = Context.get(repositoryContext, ThreadRepository.Service)
        const turns = Context.get(repositoryContext, TurnRepository.Service)
        const thread = yield* threads.create({
          id: Thread.ThreadId.make("title-workspace-thread"),
          workspace: "/thread-workspace",
          title: "Seed",
          now: 1,
        })
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("title-workspace-turn"),
          threadId: thread.id,
          prompt: "title me",
          executionRoute: executionRoutePin(SettingsDefaults.Defaults.defaults, "medium"),
          queueCapacity: 128,
          now: 1,
        })
        const workspace = yield* resolveExecutionWorkspace(
          "child:execution%3Atitle-workspace-turn:title",
          "/backend-workspace",
          repositoryLayer,
          repositoryLayer,
        )
        expect(workspace).toBe("/thread-workspace")
      }),
    ),
  ))

test("parses and builds multi-part, object, and delayed TestModel turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const json = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)([
        {
          parts: [
            { type: "reasoning", text: "inspect" },
            { type: "toolCall", name: "read", params: { path: "a.txt" }, id: "read-1" },
          ],
          delayMs: 25,
          usage: { inputTokens: 7, outputTokens: 3 },
        },
        { parts: [{ type: "text", text: "done" }] },
        { object: { summary: "reviewed", findings: [] }, delayMs: 10 },
      ])
      const parsed = yield* parseTestModelScript(json)
      expect(parsed).toHaveLength(3)
      const built = yield* buildTestModelScript(json)
      expect(built).toEqual([
        {
          _tag: "Turn",
          parts: [
            { _tag: "Reasoning", text: "inspect" },
            { _tag: "ToolCall", name: "read", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
          ],
          delay: 25,
          usage: {
            inputTokens: { uncached: 7, total: 7, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
        },
        { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
        { _tag: "Object", value: { summary: "reviewed", findings: [] }, delay: 10 },
      ])
    }),
  ))

test("builds a fresh scripted model registration after its source file changes", () =>
  Effect.runPromise(
    Effect.scoped(
      withBunServices(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-reloading-model-" })
          const script = `${root}/script.json`
          yield* fs.writeFileString(script, '[{"parts":[{"type":"text","text":"first"}]}]')
          const fixture = yield* makeReloadingTestModel(script)
          const context = yield* Layer.build(fixture.registration.layer)
          const first = yield* LanguageModel.generateText({ prompt: "first" }).pipe(Effect.provide(context))
          expect(first.text).toBe("first")
          yield* fs.writeFileString(script, '[{"parts":[{"type":"text","text":"second"}]}]')
          const reloadedContext = yield* Layer.build(fixture.registration.layer)
          const second = yield* LanguageModel.generateText({ prompt: "second" }).pipe(Effect.provide(reloadedContext))
          expect(second.text).toBe("second")
        }),
      ),
    ),
  ))

test("rejects malformed, empty, and unsafe scripts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [
          "not json",
          "[]",
          '[{"parts":[]}]',
          '[{"parts":[{"type":"toolCall","name":4}]}]',
          '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
          '[{"parts":[{"type":"text","text":"x"}],"usage":{"inputTokens":-1}}]',
        ].map((value) => Effect.exit(parseTestModelScript(value))),
      )
      expect(results.every((result) => result._tag === "Failure")).toBe(true)
    }),
  ))

test("renders configured model display names in the mode picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* Effect.scopedWith((scope) =>
          Layer.buildWithScope(
            ConfigurationService.memoryConfigurationLayer({
              global: {
                modelAliases: {
                  "gate-sonnet": {
                    preset: "claude",
                    provider: "anthropic",
                    candidates: ["claude-sonnet-5"],
                    displayName: "Sonnet 5",
                  },
                  "gate-opus": {
                    preset: "claude",
                    provider: "anthropic",
                    candidates: ["claude-opus-5"],
                    displayName: "Opus 5",
                  },
                },
                modelRoutes: {
                  modes: { high: { main: { alias: "gate-sonnet", effort: "high" }, oracle: "gate-opus" } },
                },
              },
            }),
            scope,
          ).pipe(
            Effect.flatMap((context) => ConfigurationService.effectiveConfiguration().pipe(Effect.provide(context))),
          ),
        )
        const settings = config.settings
        const setup = yield* Effect.acquireRelease(
          Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
          (value) => Effect.sync(() => value.renderer.destroy()),
        )
        const surface = yield* Effect.acquireRelease(
          Effect.sync(
            () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
          ),
          (value) => Effect.sync(() => value.destroy()),
        )
        surface.update({
          ...ViewState.withModeRouteMap(
            ViewState.initial("/workspace", "high"),
            ModelRouteLabel.modeRouteLabels(settings) as Model["modeRoutes"],
          ),
          modePicker: { open: true, selected: 2 },
        })
        yield* Effect.tryPromise(() => setup.flush())
        yield* Effect.tryPromise(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Agent:  Sonnet 5 high")
        expect(frame).toContain("Oracle: Opus 5 high")
        expect(frame).not.toContain("GPT-5.6")
      }),
    ),
  ))
