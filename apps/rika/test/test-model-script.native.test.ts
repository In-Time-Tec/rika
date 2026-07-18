import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { Cause, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { Operation } from "@rika/app"
import { ConfigContract } from "@rika/config"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ViewState } from "@rika/tui"
import { Surface } from "@rika/tui/adapter"
import {
  buildTestModelScript,
  canonicalDatabaseRoot,
  configuredBackendLayer,
  distinctModelRoutes,
  executionModelRoutes,
  executionRoutePin,
  modelRoutesForExecution,
  modelRoutePlan,
  parseTestModelScript,
  productionCompaction,
  registrationsForRoutes,
  resolveExecutionRouteForSettings,
  resolveExecutionWorkspace,
  withClientWorkspace,
  providerCredentialsForRoutes,
  persistedModelRoutesForStartup,
  persistedTitleModelRoutesForStartup,
  registrationsForPersistedRoutes,
  withPinnedRouteRegistration,
} from "../src/main"

const recordingBackend = (starts: Array<ExecutionBackend.StartInput>, registrations?: Array<string>) =>
  ExecutionBackend.Service.of({
    ...(registrations === undefined
      ? {}
      : {
          registerModels: (values) =>
            Effect.sync(() => {
              registrations.push(...values.map((value) => value.registrationKey ?? ""))
            }),
        }),
    invokeChild: () => Effect.die("unused"),
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
    listApprovals: () => Effect.succeed([]),
    resolveToolApproval: () => Effect.die("unused"),
    resolvePermission: () => Effect.die("unused"),
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

test("uses one canonical directory for both resident databases", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-database-root-" })
            const other = path.join(root, "other")
            const alias = path.join(root, "alias")
            yield* fs.makeDirectory(other)
            yield* fs.symlink(root, alias)
            expect(yield* canonicalDatabaseRoot(path.join(root, "rika.db"), path.join(alias, "relay.db"))).toBe(
              yield* fs.realPath(root),
            )
            expect(
              (yield* Effect.exit(canonicalDatabaseRoot(path.join(root, "rika.db"), path.join(other, "relay.db"))))
                ._tag,
            ).toBe("Failure")
            expect(
              (yield* Effect.exit(canonicalDatabaseRoot(path.join(root, "product.db"), path.join(root, "relay.db"))))
                ._tag,
            ).toBe("Failure")
          }),
          context,
        ),
      ),
    ),
  ))

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
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
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
    { ...route, effort: "high" as const },
    { ...route, fast: true },
    { ...route, options: { ...route.options, max_tokens: 64_000 } },
    { ...route, options: { ...route.options, service_tier: "priority" } },
    { ...route, providerConnection: { ...route.providerConnection, apiKeyEnv: undefined } },
    { ...route, providerConnection: { ...route.providerConnection, apiKeyEnv: "OTHER_API_KEY" } },
  ]
  for (const changed of changes) expect(modelRoutePlan(changed).registrationKey).not.toBe(key)
  expect(JSON.stringify(modelRoutePlan(route))).not.toContain("API_KEY_VALUE")
  expect(modelRoutePlan(route).selection.registrationKey).toBe(key)
  expect(executionRoutePin(ConfigContract.defaults, "high").oracle.providerOptions).toEqual(route.options)
  expect(executionRoutePin(ConfigContract.defaults, "high").agents?.review.alias).toBe("sol")
  expect(executionRoutePin(ConfigContract.defaults, "medium").tokenBudget).toBeUndefined()
  const settings = {
    ...ConfigContract.defaults,
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
      const route = executionRoutePin(ConfigContract.defaults, mode, { fastMode })
      for (const selected of [route.main, route.oracle, route.title!]) {
        expect(selected.model).toMatch(/^gpt-5\.6-/)
        expect(selected.providerProtocol).toBe("openai")
      }
      expect(route.main.providerOptions).toMatchObject({
        reasoning: { effort: ConfigContract.defaults.modes[mode].main.effort },
      })
      expect(route.oracle.providerOptions).toMatchObject({
        reasoning: { effort: ConfigContract.defaults.modes[mode].oracle.effort },
      })
      expect(route.main.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.oracle.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.title).toMatchObject({
        role: "title",
        alias: "luna",
        model: "gpt-5.6-luna",
        providerProtocol: "openai",
        effort: "low",
        fast: false,
        providerOptions: { reasoning: { effort: "low" } },
      })
    }
  }
})

test("fails an unavailable tuned route through the typed error channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings: ConfigContract.Settings = {
        ...ConfigContract.defaults,
        modes: {
          ...ConfigContract.defaults.modes,
          low: {
            ...ConfigContract.defaults.modes.low,
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
        const sessions = yield* Deferred.make<Operation.InteractiveSession>()
        const release = yield* Deferred.make<void>()
        const events = new Array<Operation.InteractiveEvent>()
        const settings: ConfigContract.Settings = {
          ...ConfigContract.defaults,
          modes: {
            ...ConfigContract.defaults.modes,
            low: {
              ...ConfigContract.defaults.modes.low,
              main: { alias: "fable", effort: "low" },
            },
          },
        }
        const operationLayer = Operation.productLayer({
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
        const operation = Context.get(
          yield* Layer.buildWithScope(operationLayer, yield* Effect.scope),
          Operation.Service,
        )
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

test("constructs GPT 5.6 provider registrations for every configured effort and fast variant", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const modes = Object.keys(ConfigContract.defaults.modes) as Array<ConfigContract.ModeId>
        const efforts = ["low", "medium", "high", "xhigh", "max"] as const
        const defaultRoutes = modes.flatMap((mode) =>
          executionModelRoutes(executionRoutePin(ConfigContract.defaults, mode)),
        )
        expect(defaultRoutes).toHaveLength(modes.length * (4 + Object.keys(ConfigContract.defaults.agents).length))
        expect(
          defaultRoutes
            .filter(({ provider, model }) => provider !== "openai" || !model.startsWith("gpt-5.6-"))
            .map(({ role, provider, model }) => ({ role, provider, model })),
        ).toEqual([])
        const variants = modes.flatMap((mode) =>
          efforts.flatMap((effort) => {
            const configured = ConfigContract.defaults.modes[mode]
            const settings: ConfigContract.Settings = {
              ...ConfigContract.defaults,
              modes: {
                ...ConfigContract.defaults.modes,
                [mode]: {
                  main: { ...configured.main, effort },
                  oracle: { ...configured.oracle, effort },
                },
              },
            }
            return [false, true].map((fastMode) => ({ mode, settings, tuning: { fastMode } }))
          }),
        )
        const routes = variants.flatMap(({ mode, settings, tuning }) => modelRoutesForExecution(settings, mode, tuning))
        const registrations = yield* registrationsForRoutes(routes, {
          OPENAI_API_KEY: Redacted.make("unused"),
        })
        const registered = new Set(
          registrations.map(({ provider, model, registrationKey }) => `${provider}\0${model}\0${registrationKey}`),
        )
        expect(registrations).toHaveLength(30)
        expect(
          registrations.every(({ provider, model }) => provider === "openai" && model.startsWith("gpt-5.6-")),
        ).toBe(true)
        for (const { mode, settings, tuning } of variants) {
          const pin = executionRoutePin(settings, mode, tuning)
          for (const route of [pin.main, pin.oracle, pin.title!, pin.compactionSummary!, ...Object.values(pin.agents!)])
            expect(registered.has(`${route.provider}\0${route.model}\0${route.registrationKey}`)).toBe(true)
        }
      }),
    ),
  ))

const modelRouteDisplayLabel = (route: ConfigContract.ResolvedModelRoute) => {
  const [provider, version, ...name] = route.model.split("-")
  const modelName = name.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ")
  return `${provider?.toUpperCase()}-${version} ${modelName} ${route.effort}`
}

test("renders every default mode route in the mode picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const modes = Object.keys(ConfigContract.defaults.modes) as Array<ConfigContract.ModeId>
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
            `Oracle: ${modelRouteDisplayLabel(ConfigContract.resolveModelRoute(ConfigContract.defaults, mode, "oracle"))}`,
          )
          expect(frame).toContain(
            `Agent:  ${modelRouteDisplayLabel(ConfigContract.resolveModelRoute(ConfigContract.defaults, mode, "main"))}`,
          )
        }
      }),
    ),
  ))

test("prepares each mode request with its configured reasoning effort and streaming summary", () => {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      Effect.runPromise(
        Effect.tryPromise(() => request.json()).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              requests.push(value as Record<string, unknown>)
            }),
          ),
          Effect.as(Response.json({})),
          Effect.orDie,
        ),
      ),
  })
  const settings: ConfigContract.Settings = {
    ...ConfigContract.defaults,
    providers: {
      ...ConfigContract.defaults.providers,
      openai: {
        protocol: "openai",
        baseUrl: server.url.toString(),
      },
    },
  }
  const modes = ["low", "medium", "high", "ultra"] as const
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forEach(
          modes,
          (mode) =>
            Effect.gen(function* () {
              const route = ConfigContract.resolveModelRoute(settings, mode, "main")
              const registration = (yield* registrationsForRoutes([route], {}))[0]!
              const context = yield* Layer.build(registration.layer)
              yield* Effect.exit(LanguageModel.generateText({ prompt: mode }).pipe(Effect.provide(context)))
            }),
          { discard: true },
        )
        expect(requests.map((request) => request.reasoning)).toEqual([
          { effort: "low", summary: "auto" },
          { effort: "medium", summary: "auto" },
          { effort: "xhigh", summary: "auto" },
          { effort: "max", summary: "auto" },
        ])
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          server.stop(true)
        }),
      ),
    ),
  )
})

test("constructs the retained Anthropic provider registration", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings: ConfigContract.Settings = {
          ...ConfigContract.defaults,
          providers: {
            ...ConfigContract.defaults.providers,
            anthropic: {
              protocol: "anthropic",
              baseUrl: ConfigContract.defaults.providers.anthropic!.baseUrl,
            },
          },
          modes: {
            ...ConfigContract.defaults.modes,
            low: {
              ...ConfigContract.defaults.modes.low,
              main: { alias: "fable", effort: "low" },
            },
          },
        }
        const route = ConfigContract.resolveModelRoute(settings, "low", "main")
        const registrations = yield* registrationsForRoutes([route], {})
        expect(
          registrations.map(({ provider, model, registrationKey }) => ({ provider, model, registrationKey })),
        ).toEqual([
          {
            provider: "anthropic",
            model: "claude-fable-5",
            registrationKey: modelRoutePlan(route).registrationKey,
          },
        ])
      }),
    ),
  ))

test("keeps registrations distinct by the exact Baton registry tuple", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
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
  expect(withClientWorkspace({ _tag: "Thread", action: "new" }, "/client-d")).toEqual({
    _tag: "Thread",
    action: "new",
    clientWorkspace: "/client-d",
  })
  expect(withClientWorkspace({ _tag: "Mcp", action: "approve", name: "server" }, "/client-e")).toEqual({
    _tag: "Mcp",
    action: "approve",
    name: "server",
    workspace: "/client-e",
    clientWorkspace: "/client-e",
  })
})

test("loads credentials named by configured and persisted routes", () => {
  const configured = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
  const persisted = {
    ...executionRoutePin(ConfigContract.defaults, "medium").oracle,
    providerApiKeyEnv: "RESTART_ORACLE_KEY",
  }
  const values = { OPENAI_API_KEY: "starter", RESTART_ORACLE_KEY: "persisted" } as const
  const credentials = providerCredentialsForRoutes(
    [configured],
    [persisted],
    {},
    (name) => values[name as keyof typeof values],
  )
  expect(Redacted.value(credentials.OPENAI_API_KEY!)).toBe("starter")
  expect(Redacted.value(credentials.RESTART_ORACLE_KEY!)).toBe("persisted")
  expect(JSON.stringify(credentials)).not.toContain("starter")
  expect(JSON.stringify(credentials)).not.toContain("persisted")
})

test("isolates a stale persisted route while healthy routes keep starting", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const route = executionRoutePin(ConfigContract.defaults, "medium")
        const { providerApiKeyEnv: _, ...healthy } = route.main
        const stale = {
          ...route.main,
          alias: "retired",
          provider: "retired-provider",
          registrationKey: "retired-registration",
          providerApiKeyEnv: "RETIRED_API_KEY",
          requestVariant: "retired-registration",
        }
        const startup = yield* registrationsForPersistedRoutes([healthy, stale], {})
        expect(startup.registrations).toHaveLength(1)
        expect(startup.unavailable).toHaveLength(1)
        expect(startup.unavailable[0]?.route.alias).toBe("retired")
        expect(startup.unavailable[0]?.route.registrationKey).toBe("retired-registration")
        expect(startup.unavailable[0]?.message).toContain("RETIRED_API_KEY")
        const starts = new Array<ExecutionBackend.StartInput>()
        const backend = recordingBackend(starts)
        const isolated = yield* withPinnedRouteRegistration(backend, {
          registeredRoutes: [healthy],
          unavailable: startup.unavailable,
          providerCredentials: {},
        })
        const input = {
          threadId: "thread",
          turnId: "healthy-turn",
          prompt: "healthy",
          startedAt: 1,
          executionRoute: {
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

test("builds the configured backend when one persisted route cannot be registered", () =>
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
          const settings: ConfigContract.Settings = {
            ...ConfigContract.defaults,
            providers: {
              ...ConfigContract.defaults.providers,
              openai: {
                protocol: "openai",
                baseUrl: ConfigContract.defaults.providers.openai!.baseUrl,
              },
            },
          }
          const routes = modelRoutesForExecution(settings, "medium")
          const main = ConfigContract.resolveModelRoute(settings, "medium", "main")
          const oracle = ConfigContract.resolveModelRoute(settings, "medium", "oracle")
          const summary = ConfigContract.resolveCompactionSummaryRoute(settings)
          const pinned = executionRoutePin(settings, "medium")
          const stale = {
            ...pinned.main,
            alias: "retired-startup",
            provider: "retired-startup",
            registrationKey: "retired-startup",
            providerApiKeyEnv: "RETIRED_STARTUP_API_KEY",
            requestVariant: "retired-startup",
          }
          const context = yield* Layer.buildWithScope(
            configuredBackendLayer(
              path.join(root, "relay.db"),
              "/work",
              repositoryLayer,
              turnRepositoryLayer,
              undefined,
              main,
              {},
              routes,
              oracle,
              [stale],
              summary,
            ),
            yield* Effect.scope,
          )
          const backend = Context.get(context, ExecutionBackend.Service)
          const failed = yield* Effect.exit(
            backend.start({
              threadId: "stale-thread",
              turnId: "stale-startup-turn",
              prompt: "stale",
              startedAt: 1,
              executionRoute: {
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
              message: expect.stringMatching(/retired-startup.*RETIRED_STARTUP_API_KEY/),
            })
          }
        }),
      ),
    ),
  ))

test("resolves a legacy unavailable route to the current default when it starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = executionRoutePin(ConfigContract.defaults, "medium")
      const legacyModel = {
        ...current.main,
        alias: "legacy-unavailable",
        provider: "legacy-unavailable",
        model: "legacy-unavailable",
        registrationKey: "legacy-unavailable",
        providerProtocol: "test" as const,
        providerBaseUrl: "test://legacy-unavailable",
        requestVariant: "legacy-unavailable",
      }
      const legacy: Turn.ExecutionRoutePin = {
        mode: "test",
        main: legacyModel,
        oracle: { ...legacyModel, role: "oracle" },
      }
      const starts = new Array<ExecutionBackend.StartInput>()
      const isolated = yield* withPinnedRouteRegistration(recordingBackend(starts), {
        registeredRoutes: [
          current.main,
          current.oracle,
          current.title!,
          current.compactionSummary!,
          ...Object.values(current.agents!),
        ],
        unavailable: [],
        providerCredentials: {},
        resolveLegacyRoute: () => Effect.succeed({ executionRoute: current, registrations: [] }),
      })
      yield* isolated.start({
        threadId: "legacy-thread",
        turnId: "legacy-turn",
        prompt: "backfilled",
        startedAt: 1,
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
      const cloned = executionRoutePin(ConfigContract.defaults, "high")
      const starts = new Array<ExecutionBackend.StartInput>()
      const registrations = new Array<string>()
      const isolated = yield* withPinnedRouteRegistration(recordingBackend(starts, registrations), {
        registeredRoutes: [],
        unavailable: [],
        providerCredentials: { OPENAI_API_KEY: Redacted.make("unused") },
      })
      yield* isolated.start({
        threadId: "interrupt-thread",
        turnId: "interrupt-successor",
        prompt: "continue",
        startedAt: 1,
        executionRoute: cloned,
      })
      expect(starts).toHaveLength(1)
      expect(registrations).toContain(cloned.main.registrationKey)
      expect(registrations).toContain(cloned.oracle.registrationKey)
    }),
  ))

test("keeps a review route owner's workspace-specific models in the startup registration set", () => {
  const route = executionRoutePin(ConfigContract.defaults, "high")
  const owner: Turn.Turn = {
    id: Turn.TurnId.make("review-owner"),
    threadId: "review-thread" as Turn.Turn["threadId"],
    prompt: "Review workspace changes",
    status: "running",
    executionRoute: {
      ...route,
      main: { ...route.main, registrationKey: "workspace-main" },
      oracle: { ...route.oracle, registrationKey: "workspace-oracle" },
    },
    reviewFanOutId: "review:review-owner",
    createdAt: 1,
    updatedAt: 2,
  }
  expect(persistedModelRoutesForStartup([owner]).map((candidate) => candidate.registrationKey)).toEqual([
    "workspace-main",
    "workspace-oracle",
    route.title!.registrationKey,
    route.compactionSummary!.registrationKey,
    route.agents!.librarian.registrationKey,
    route.agents!.painter.registrationKey,
    route.agents!.review.registrationKey,
    route.agents!.readThread.registrationKey,
    route.agents!.task.registrationKey,
  ])
  const titleOwner: Turn.Turn = {
    ...owner,
    id: Turn.TurnId.make("completed-title-owner"),
    status: "completed",
    executionRoute: {
      ...route,
      title: { ...route.title!, registrationKey: "completed-title-route" },
    },
  }
  expect(
    [...persistedModelRoutesForStartup([owner]), titleOwner.executionRoute.title!].map(
      (candidate) => candidate.registrationKey,
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
          const route = executionRoutePin(ConfigContract.defaults, "medium")
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
                title: { ...route.title!, registrationKey: "durable-title-registration" },
              },
              queueCapacity: 128,
              now: 1,
            })
            yield* turns.setStatus(turn.id, "completed", undefined, 2)
          }).pipe(Effect.provide(repositories))
          const titleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(Effect.provide(databaseContext))
          expect(titleRoutes.map((candidate) => candidate.registrationKey)).toContain("durable-title-registration")
        }),
      ),
    ),
  ))

test("uses the backend workspace for durable title executions without a Turn row", () =>
  Effect.runPromise(
    resolveExecutionWorkspace(
      "execution:title:title-restart-thread:123",
      "/backend-workspace",
      ThreadRepository.memoryLayer(),
      TurnRepository.memoryLayer(),
    ).pipe(Effect.tap((workspace) => Effect.sync(() => expect(workspace).toBe("/backend-workspace")))),
  ))

test("parses and builds multi-part, object, and delayed TestModel turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const json = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)([
        {
          parts: [
            { type: "reasoning", text: "inspect" },
            { type: "toolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1" },
          ],
          delayMs: 25,
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
            { _tag: "ToolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
          ],
          delay: 25,
        },
        { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
        { _tag: "Object", value: { summary: "reviewed", findings: [] }, delay: 10 },
      ])
    }),
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
        ].map((value) => Effect.exit(parseTestModelScript(value))),
      )
      expect(results.every((result) => result._tag === "Failure")).toBe(true)
    }),
  ))
