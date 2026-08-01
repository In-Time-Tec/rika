import * as ConfigurationSettings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadSearchRepository from "@rika/product/thread-search-repository"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as ThreadToolService from "@rika/product/thread-tool-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import Route from "./relay-execution-route"
import { Config, Effect, Layer, PlatformError, Schedule } from "effect"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import ProductTools from "./relay-product-tools"
import { ModelResilience } from "@batonfx/core"

const defaultModelResilience: ModelResilience.Interface = {
  ...ModelResilience.none,
  classify: ModelResilience.defaultClassify,
  resolve: ModelResilience.defaultResolveFailure,
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
}

export interface RouteFailure {
  readonly route: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot
  readonly message: string
}

interface RepositoryLayers {
  readonly thread: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>
  readonly turn: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>
  readonly transcript: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>
  readonly search: Layer.Layer<ThreadSearchRepository.Service, ThreadSearchRepository.RepositoryError, never>
  readonly interaction: Layer.Layer<
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.RepositoryError,
    never
  >
}

type LegacyRouteResolution =
  | ExecutionRouteSnapshot.ExecutionRoutePin
  | {
      readonly executionRoute: ExecutionRouteSnapshot.ExecutionRoutePin
      readonly registrations?: ReadonlyArray<unknown>
    }

export interface ConfiguredOptions {
  readonly filename: string
  readonly workspace: string
  readonly settings?: ConfigurationSettings.ConfigurationSettings
  readonly persistedModelRoutes?: ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot>
  readonly webSearchCredentials?: Readonly<Record<string, import("effect").Redacted.Redacted<string>>>
  readonly repositories: RepositoryLayers
  readonly threadToolGateway: ThreadToolService.Gateway
  readonly providerAuthLayer?: Layer.Layer<OpenAiAuth.Service>
  readonly resolveLegacyRoute?: (
    input: ExecutionRequest.StartInput,
  ) => Effect.Effect<LegacyRouteResolution, ExecutionBackend.BackendError>
  readonly toolRuntimeLayerForWorkspace: (
    workspace: string,
  ) => Layer.Layer<ToolRuntime.Service, ExecutionBackend.BackendError, never>
}

const executionModelRoutes = (
  route: ExecutionRouteSnapshot.ExecutionRoutePin,
): ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot> => [
  route.main,
  route.oracle,
  ...(route.title === undefined ? [] : [route.title]),
  ...(route.compactionSummary === undefined ? [] : [route.compactionSummary]),
  ...(route.agents === undefined ? [] : Object.values(route.agents)),
]

const unavailableRouteError = (failure: RouteFailure) =>
  ExecutionBackend.BackendError.make({
    message: `Model route ${failure.route.alias}/${failure.route.effort}${failure.route.fast ? "/fast" : ""} is unavailable: ${failure.message}`,
  })

const withPinnedRouteRegistration = Effect.fn("Relay.withPinnedRouteRegistration")(function* (
  backend: ExecutionBackend.Interface,
  options: {
    readonly resolveLegacyRoute?: ConfiguredOptions["resolveLegacyRoute"]
    readonly unavailable?: ReadonlyArray<RouteFailure>
    readonly registeredRoutes?: ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot>
    readonly registerPinnedRoutes?: (
      routes: ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot>,
    ) => Effect.Effect<ReadonlyArray<unknown>, ExecutionBackend.BackendError>
  },
) {
  yield* Effect.void
  return ExecutionBackend.Service.of({
    ...backend,
    start: (input) =>
      Effect.gen(function* () {
        const unavailable = options.unavailable?.find((failure) =>
          executionModelRoutes(input.executionRoute).some(
            (candidate) => Route.registrationTuple(candidate) === Route.registrationTuple(failure.route),
          ),
        )
        if (unavailable !== undefined) return yield* unavailableRouteError(unavailable)
        const registered = new Set((options.registeredRoutes ?? []).map(Route.registrationTuple))
        const missing = executionModelRoutes(input.executionRoute).filter(
          (candidate, index, all) =>
            !registered.has(Route.registrationTuple(candidate)) &&
            all.findIndex((other) => Route.registrationTuple(other) === Route.registrationTuple(candidate)) === index,
        )
        if (missing.length > 0 && options.registerPinnedRoutes !== undefined)
          yield* options.registerPinnedRoutes(missing)
        if (input.executionRoute.main.registrationIdentity !== "legacy-unavailable") return yield* backend.start(input)
        if (options.resolveLegacyRoute === undefined)
          return yield* ExecutionBackend.BackendError.make({
            message: `Turn ${input.turnId} uses the legacy unavailable model route and cannot be started`,
          })
        return yield* options.resolveLegacyRoute(input).pipe(
          Effect.flatMap((resolved) =>
            backend.start({
              ...input,
              executionRoute: "executionRoute" in resolved ? resolved.executionRoute : resolved,
            }),
          ),
        )
      }),
  })
})

const readEnvironment = Effect.gen(function* () {
  const response = yield* Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE"))
  const script = yield* Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT"))
  if (response._tag === "Some" && script._tag === "Some")
    return yield* ExecutionBackend.BackendError.make({
      message: "RIKA_TEST_MODEL_RESPONSE and RIKA_TEST_MODEL_SCRIPT cannot both be set",
    })
  if (script._tag === "Some") return { _tag: "script" as const, value: script.value }
  if (response._tag === "Some") return { _tag: "response" as const, value: response.value }
  return undefined
})

const configuredLayer: (
  options: ConfiguredOptions,
) => Layer.Layer<
  ExecutionBackend.Service,
  | ExecutionBackend.BackendError
  | Config.ConfigError
  | PlatformError.PlatformError
  | import("@relayfx/sdk").Runtime.AcquisitionError,
  import("./relay-execution-layer").ExternalToolRuntimeRequirements<never>
> = (options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const settings = options.settings ?? ConfigurationSettings.Defaults.defaults
      const configuredRoutes = Route.defaultModelRoutes(settings)
      const testModel = yield* readEnvironment
      let registration: import("@batonfx/core").ModelRegistry.Registration
      let selection: import("@batonfx/core").ModelRegistry.ModelSelection
      let additionalRegistrations: ReadonlyArray<import("@batonfx/core").ModelRegistry.Registration> = []
      let unavailable: ReadonlyArray<RouteFailure> = []
      let modelVariantPolicy: "registration-key" | "fixed-selection" = "registration-key"
      let compaction = Route.productionCompaction()
      let oracleCompaction = Route.productionCompaction()
      if (testModel !== undefined) {
        const fixture = yield* Route.testModel(
          testModel._tag === "script" ? { script: testModel.value } : { response: testModel.value },
        )
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else {
        const prepared = yield* Route.prepareExecutionRoutes({
          routes: configuredRoutes,
          persisted: options.persistedModelRoutes ?? [],
          ...(options.providerAuthLayer === undefined ? {} : { providerAuthLayer: options.providerAuthLayer }),
        }).pipe(Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })))
        unavailable = prepared.unavailable
        if (prepared.registrations.length === 0)
          return yield* ExecutionBackend.BackendError.make({
            message: "No configured model routes could be registered",
          })
        registration = prepared.registrations[0]!
        additionalRegistrations = prepared.registrations.slice(1)
        const plan = Route.executionRoutePinFromPrepared("medium", prepared.prepared)
        selection = {
          provider: plan.main.providerConnection.provider,
          model: plan.main.model,
          registrationKey: plan.main.requestVariant,
        }
        compaction = plan.main.compaction
        oracleCompaction = plan.oracle.compaction
      }
      const backendLayer = ProductTools.relayBackendLayer(
        {
          filename: options.filename,
          workspace: options.workspace,
          registration,
          ...(additionalRegistrations.length === 0 ? {} : { additionalRegistrations }),
          selection,
          oracleSelection: selection,
          compaction,
          oracleCompaction,
          modelVariantPolicy,
          ...(testModel === undefined ? { modelResilience: defaultModelResilience } : {}),
          toolRuntimeLayerForWorkspace: (workspace) => options.toolRuntimeLayerForWorkspace(workspace),
          resolveWorkspace: () => Effect.succeed(options.workspace),
          ...(options.webSearchCredentials === undefined ? {} : { webSearchCredentials: options.webSearchCredentials }),
        },
        options.repositories,
        options.threadToolGateway,
      ).pipe(Layer.provide(BunCrypto.layer))
      const backend =
        testModel === undefined
          ? Layer.effect(
              ExecutionBackend.Service,
              ExecutionBackend.Service.pipe(
                Effect.flatMap((service) =>
                  withPinnedRouteRegistration(service, {
                    ...(options.resolveLegacyRoute === undefined
                      ? {}
                      : { resolveLegacyRoute: options.resolveLegacyRoute }),
                    ...(unavailable.length === 0 ? {} : { unavailable }),
                  }),
                ),
              ),
            ).pipe(Layer.provide(backendLayer))
          : backendLayer
      return backend
    }),
  ).pipe(Layer.provide(BunCrypto.layer))

const makeConfiguredLayer = configuredLayer
const makeConfiguredRoute = (
  settings: ConfigurationSettings.ConfigurationSettings,
  mode: "low" | "medium" | "high" | "ultra",
  tuning?: { readonly fastMode?: boolean },
): Effect.Effect<ExecutionRouteSnapshot.ExecutionRoutePin, ExecutionBackend.BackendError> =>
  Route.resolveExecutionRouteForSettings(settings, mode, tuning).pipe(
    Effect.map((result) => result.executionRoute),
    Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
  )
const configuredRoute = Route.executionRoutePin
const configuredExecutionModelRoutes = executionModelRoutes
const configuredWithPinnedRouteRegistration = withPinnedRouteRegistration

export default {
  makeConfiguredLayer,
  makeConfiguredRoute,
  configuredRoute,
  configuredExecutionModelRoutes,
  configuredWithPinnedRouteRegistration,
}
