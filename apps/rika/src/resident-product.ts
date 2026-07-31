#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import {
  ConfigOperations,
  ContextFileSystem,
  ExtensionOperations,
  Operation,
  ResidentService,
  ResolvedContext,
  ThreadQuery,
  ThreadToolHandlers,
  ThreadToolService,
} from "@rika/product/product-operation"
import { ConfigContract, ConfigService, Models } from "@rika/configuration/configuration-settings"
import { McpOAuth, SkillRegistry } from "@rika/extensions/plugin-contract"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as Turn from "@rika/product/turn-record"
import { modelRegistrationIdentity } from "@rika/product/execution-route-snapshot"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as RelayExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import {
  MediaView,
  ReadWebPage,
  Runtime as ToolRuntime,
  ThreadTools,
  WebSearch,
  WorkspaceIndex,
} from "@rika/coding-tools/coding-tool-catalog"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  Cause,
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Function,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as BedrockAuthRefresh from "@rika/relay-execution/model-provider-runtime"
import { lazyBackendLayer } from "./lazy-backend"
import * as ModelProviderRuntime from "@rika/relay-execution/model-provider-runtime"
import * as ScriptedModelRuntime from "@rika/relay-execution/scripted-model-runtime"
import { modeIds } from "@rika/configuration/behavior-mode"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"

const pathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const dirname = pathService.dirname
const join = pathService.join

const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

const mkdir = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))

const workspaceGlobError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "WorkspaceIndex",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

const workspaceGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  provideLayerScoped(BunServices.layer)(
    WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
      Effect.map((result) => result.items.map((item) => item.relativePath)),
      Effect.mapError((error) => workspaceGlobError(workspace, error.operation, error)),
    ),
  )

export class PromptAttachmentError extends Schema.TaggedErrorClass<PromptAttachmentError>()("PromptAttachmentError", {
  index: Schema.Int,
  path: Schema.String,
  message: Schema.String,
}) {}

export class ModelConfigurationError extends Schema.TaggedErrorClass<ModelConfigurationError>()(
  "ModelConfigurationError",
  { message: Schema.String },
) {}

export const validateWebSearchProviders = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => {
  const unsupportedIds = RelayExecutionBackend.webSearchFactories(credentials).unsupportedIds
  return unsupportedIds.length === 0
    ? Effect.void
    : ModelConfigurationError.make({
        message: `Unknown web search provider ${unsupportedIds.map((id) => `'${id}'`).join(", ")}`,
      })
}

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()("WorkspaceFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

class ExternalBoundaryError extends Schema.TaggedErrorClass<ExternalBoundaryError>()("ExternalBoundaryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

class OperationProductError extends Schema.TaggedErrorClass<OperationProductError>()("OperationError", {
  message: Schema.String,
}) {}

const relayBackendLayerImpl = (
  options: Omit<
    RelayExecutionBackend.LayerOptions<typeof ThreadTools.allToolkit.tools>,
    "additionalToolkit" | "additionalHandlerLayer"
  >,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
  transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>,
  threadSearchRepositoryLayer: Layer.Layer<
    ThreadSearchRepository.Service,
    ThreadSearchRepository.RepositoryError,
    never
  >,
  threadInteractionRepositoryLayer: Layer.Layer<
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.RepositoryError,
    never
  >,
  gateway: ThreadToolService.Gateway,
): ReturnType<typeof RelayExecutionBackend.layer<typeof ThreadTools.allToolkit.tools>> =>
  RelayExecutionBackend.layer({
    ...options,
    additionalToolkit: ThreadTools.allToolkit,
    additionalHandlerLayer: Layer.merge(
      Layer.merge(
        ThreadToolHandlers.handlerLayerForWorkspace(
          options.resolveWorkspace ?? (() => Effect.succeed(options.workspace ?? "")),
        ),
        ThreadToolHandlers.findHandlerLayerForWorkspace(
          options.resolveWorkspace ?? (() => Effect.succeed(options.workspace ?? "")),
        ),
      ).pipe(
        Layer.provide(
          ThreadQuery.factoryLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                repositoryLayer,
                turnRepositoryLayer,
                transcriptRepositoryLayer,
                threadSearchRepositoryLayer,
                threadInteractionRepositoryLayer,
              ),
            ),
          ),
        ),
      ),
      ThreadToolHandlers.coordinationHandlerLayer(gateway),
    ).pipe(
      Layer.catchCause((cause) =>
        Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) }))),
      ),
    ),
  })

export const relayBackendLayer: {
  (
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
    transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>,
    threadSearchRepositoryLayer: Layer.Layer<
      ThreadSearchRepository.Service,
      ThreadSearchRepository.RepositoryError,
      never
    >,
    threadInteractionRepositoryLayer: Layer.Layer<
      ThreadInteractionRepository.Service,
      ThreadInteractionRepository.RepositoryError,
      never
    >,
    gateway: ThreadToolService.Gateway,
  ): (
    options: Omit<
      RelayExecutionBackend.LayerOptions<typeof ThreadTools.allToolkit.tools>,
      "additionalToolkit" | "additionalHandlerLayer"
    >,
  ) => ReturnType<typeof relayBackendLayerImpl>
  (
    options: Omit<
      RelayExecutionBackend.LayerOptions<typeof ThreadTools.allToolkit.tools>,
      "additionalToolkit" | "additionalHandlerLayer"
    >,
    repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
    turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
    transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>,
    threadSearchRepositoryLayer: Layer.Layer<
      ThreadSearchRepository.Service,
      ThreadSearchRepository.RepositoryError,
      never
    >,
    threadInteractionRepositoryLayer: Layer.Layer<
      ThreadInteractionRepository.Service,
      ThreadInteractionRepository.RepositoryError,
      never
    >,
    gateway: ThreadToolService.Gateway,
  ): ReturnType<typeof relayBackendLayerImpl>
} = Function.dual(7, relayBackendLayerImpl)

const resolveTunedModeRoute = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  role: ConfigContract.Role,
  tuning?: { readonly fastMode?: boolean },
) => {
  const configured = settings.modes[mode][role]
  const fast = tuning?.fastMode ?? configured.fast ?? false
  const routedSettings: ConfigContract.Settings = {
    ...settings,
    modes: {
      ...settings.modes,
      [mode]: { ...settings.modes[mode], [role]: { ...configured, fast } },
    },
  }
  return ConfigContract.resolveModelRoute(routedSettings, mode, role)
}

const supportingModelRoutes = (settings: ConfigContract.Settings) => [
  ConfigContract.resolveThreadTitleRoute(settings),
  ConfigContract.resolveCompactionSummaryRoute(settings),
]

const modelRoutesForExecutionImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
) => [
  resolveTunedModeRoute(settings, mode, "main", tuning),
  resolveTunedModeRoute(settings, mode, "oracle", tuning),
  ...supportingModelRoutes(settings),
  ...ConfigContract.agentIds.map((agent) => ConfigContract.resolveAgentRoute(settings, mode, agent, tuning)),
]

export const modelRoutesForExecution: {
  (
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigContract.Settings) => ReturnType<typeof modelRoutesForExecutionImpl>
  (
    settings: ConfigContract.Settings,
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ReturnType<typeof modelRoutesForExecutionImpl>
} = Function.dual((args) => typeof args[0] === "object", modelRoutesForExecutionImpl)

const defaultModelRoutes = (settings: ConfigContract.Settings) => [
  ...modeIds.flatMap((mode) => [
    ConfigContract.resolveModelRoute(settings, mode, "main"),
    ConfigContract.resolveModelRoute(settings, mode, "oracle"),
  ]),
  ...supportingModelRoutes(settings),
]

type PreparedPlan = ModelProviderRuntime.PreparedRoutes["plans"][number]

const executionModelRoute = (
  route: ConfigContract.ResolvedModelRoute,
  plan: PreparedPlan,
  role: Turn.ExecutionModelRoute["role"],
): Turn.ExecutionModelRoute => ({
  role,
  alias: route.alias,
  model: plan.selection.model,
  providerConnection: {
    provider: plan.selection.provider,
    protocol: route.providerConnection.protocol,
    baseUrl:
      route.providerConnection.protocol === "amazon-bedrock"
        ? (route.providerConnection.endpoint ?? "bedrock://default")
        : ModelProviderRuntime.normalizedBaseUrl(route.providerConnection.baseUrl),
    authentication:
      plan.runtime.adapter === "openai-account"
        ? "openai-account"
        : route.providerConnection.apiKeyEnv === undefined
          ? "none"
          : "api-key",
    ...(route.providerConnection.apiKeyEnv === undefined
      ? {}
      : { apiKeyEnvironment: route.providerConnection.apiKeyEnv }),
  },
  registrationIdentity: modelRegistrationIdentity(plan.registrationKey),
  effort: route.effort,
  fast: route.fast,
  requestVariant: plan.registrationKey,
  providerOptions: plan.options,
  compaction: route.compaction,
})

const executionRoutePinFromPreparedImpl = (
  mode: ConfigContract.ModeId,
  prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
): Turn.ExecutionRoutePin => {
  const routes = prepared.routes
  const plans = prepared.plans
  if (routes.length !== 10 || plans.length !== routes.length)
    throw new Error(`Expected ten prepared execution routes, received ${routes.length}`)
  const main = executionModelRoute(routes[0]!, plans[0]!, "main")
  const oracle = executionModelRoute(routes[1]!, plans[1]!, "oracle")
  const agents = {
    librarian: executionModelRoute(routes[4]!, plans[4]!, "librarian"),
    painter: executionModelRoute(routes[5]!, plans[5]!, "painter"),
    review: executionModelRoute(routes[6]!, plans[6]!, "review"),
    readThread: executionModelRoute(routes[7]!, plans[7]!, "readThread"),
    surgeon: executionModelRoute(routes[8]!, plans[8]!, "surgeon"),
    task: executionModelRoute(routes[9]!, plans[9]!, "task"),
  }
  const inherited = (agent: keyof typeof agents) =>
    agents[agent].registrationIdentity ===
    (agent === "task" || agent === "surgeon" ? main : oracle).registrationIdentity
  const allInherited = (Object.keys(agents) as Array<keyof typeof agents>).every(inherited)
  return {
    version: 1,
    mode,
    main,
    oracle,
    title: executionModelRoute(routes[2]!, plans[2]!, "title"),
    compactionSummary: executionModelRoute(routes[3]!, plans[3]!, "compaction"),
    ...(allInherited ? {} : { agents }),
  }
}

export const executionRoutePinFromPrepared: {
  (
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): (mode: ConfigContract.ModeId) => Turn.ExecutionRoutePin
  (
    mode: ConfigContract.ModeId,
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): Turn.ExecutionRoutePin
} = Function.dual(2, executionRoutePinFromPreparedImpl)

const executionRoutePinImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
): Turn.ExecutionRoutePin => {
  const routes = modelRoutesForExecution(settings, mode, tuning)
  return executionRoutePinFromPrepared(mode, {
    routes,
    plans: routes.map((route) => ModelProviderRuntime.modelRoutePlan(route)),
  })
}

export const executionRoutePin: {
  (
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigContract.Settings) => Turn.ExecutionRoutePin
  (
    settings: ConfigContract.Settings,
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): Turn.ExecutionRoutePin
} = Function.dual((args) => typeof args[0] === "object", executionRoutePinImpl)

export const resolveExecutionRouteForSettings = Effect.fn("Main.resolveExecutionRouteForSettings")(function* (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
) {
  return yield* Effect.try({
    try: () => ({
      routes: modelRoutesForExecution(settings, mode, tuning),
      executionRoute: executionRoutePin(settings, mode, tuning),
    }),
    catch: (cause) =>
      Schema.is(ConfigContract.ModelRouteError)(cause)
        ? cause
        : ModelConfigurationError.make({
            message: `Could not resolve model route: ${String(cause)}`,
          }),
  })
})

export const productionCompaction = (
  route?: Pick<ConfigContract.ResolvedModelRoute, "compaction">,
): ModelProviderRuntime.CompactionOptions => ({
  contextWindow: route?.compaction.contextWindow ?? Models.defaultCompaction.contextWindow,
  reserveTokens: route?.compaction.reserveTokens ?? Models.defaultCompaction.reserveTokens,
  keepRecentTokens: route?.compaction.keepRecentTokens ?? Models.defaultCompaction.keepRecentTokens,
})

const registrationTuple = (
  candidate:
    | { readonly provider: string; readonly model: string; readonly registrationKey?: string }
    | Turn.ExecutionModelRoute,
) =>
  "providerConnection" in candidate
    ? `${candidate.providerConnection.provider}\0${candidate.model}\0${candidate.registrationIdentity}`
    : `${candidate.provider}\0${candidate.model}\0${candidate.registrationKey ?? ""}`

export interface PersistedRouteRegistrationFailure {
  readonly route: Turn.ExecutionModelRoute
  readonly message: string
}

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return failure instanceof Error ? failure.message : String(failure)
}

export const executionModelRoutes = (route: Turn.ExecutionRoutePin): ReadonlyArray<Turn.ExecutionModelRoute> => [
  route.main,
  route.oracle,
  ...(route.title === undefined ? [] : [route.title]),
  ...(route.compactionSummary === undefined ? [] : [route.compactionSummary]),
  ...(route.agents === undefined ? [] : Object.values(route.agents)),
]

export const isLegacyUnavailableExecutionRoute = (route: Turn.ExecutionRoutePin) =>
  executionModelRoutes(route).some(
    (candidate) => candidate.registrationIdentity === modelRegistrationIdentity("legacy-unavailable"),
  )

const unavailableRouteError = (failure: PersistedRouteRegistrationFailure) =>
  ExecutionBackend.BackendError.make({
    message: `Model route ${failure.route.alias}/${failure.route.effort}${failure.route.fast ? "/fast" : ""} is unavailable: ${failure.message}`,
  })

export const resolveExecutionWorkspace = Effect.fn("Main.resolveExecutionWorkspace")(function* (
  durableExecutionId: string,
  _defaultWorkspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
) {
  const program = Effect.gen(function* () {
    const turnId = RelayExecutionBackend.turnIdFromExecutionId(durableExecutionId)
    const executionWorkspace = RelayExecutionBackend.workspaceFromExecutionId(durableExecutionId)
    if (executionWorkspace !== undefined) return executionWorkspace
    if (turnId === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Execution ${durableExecutionId} is not attached to a Rika Turn`,
      })
    const turns = yield* TurnRepository.Service
    const turn = yield* turns.get(Turn.TurnId.make(turnId))
    if (turn === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Turn ${turnId} does not exist`,
      })
    const threads = yield* ThreadRepository.Service
    const thread = yield* threads.get(turn.threadId)
    if (thread === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Thread ${turn.threadId} does not exist`,
      })
    return thread.workspace
  })
  return yield* program.pipe(
    provideLayerScoped(Layer.merge(repositoryLayer, turnRepositoryLayer)),
    Effect.mapError((cause) =>
      Schema.is(ExecutionBackend.BackendError)(cause)
        ? cause
        : ExecutionBackend.BackendError.make({ message: String(cause) }),
    ),
  )
})

export const withPinnedRouteRegistration = Effect.fn("Main.withPinnedRouteRegistration")(function* (
  backend: ExecutionBackend.Interface,
  options: {
    readonly resolveLegacyRoute?: (
      input: ExecutionBackend.StartInput,
    ) => Effect.Effect<{ readonly executionRoute: Turn.ExecutionRoutePin }, ExecutionBackend.BackendError>
  },
) {
  return ExecutionBackend.Service.of({
    ...backend,
    start: (input) =>
      Effect.gen(function* () {
        if (!isLegacyUnavailableExecutionRoute(input.executionRoute)) return yield* backend.start(input)
        if (options.resolveLegacyRoute === undefined)
          return yield* ExecutionBackend.BackendError.make({
            message: `Turn ${input.turnId} uses the legacy unavailable model route and cannot be started`,
          })
        const resolved = yield* options.resolveLegacyRoute(input)
        return yield* backend.start({ ...input, executionRoute: resolved.executionRoute })
      }),
  })
})

export interface ConfiguredBackendOptions {
  readonly filename: string
  readonly workspace: string
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>
  readonly transcriptRepositoryLayer: Layer.Layer<
    TranscriptRepository.Service,
    TranscriptRepository.RepositoryError,
    never
  >
  readonly threadSearchRepositoryLayer: Layer.Layer<
    ThreadSearchRepository.Service,
    ThreadSearchRepository.RepositoryError,
    never
  >
  readonly threadInteractionRepositoryLayer: Layer.Layer<
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.RepositoryError,
    never
  >
  readonly settings?: ConfigContract.Settings
  readonly persistedModelRoutes?: ReadonlyArray<Turn.ExecutionModelRoute>
  readonly webSearchCredentials?: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly resolveLegacyRoute?: (input: ExecutionBackend.StartInput) => Effect.Effect<
    {
      readonly executionRoute: Turn.ExecutionRoutePin
      readonly registrations: ReadonlyArray<ModelProviderRuntime.ModelRegistration>
    },
    ExecutionBackend.BackendError
  >
  readonly globalSettings?: ConfigContract.SettingsInput
  readonly threadToolGateway: ThreadToolService.Gateway
}

export const configuredBackendLayer = ({
  filename,
  workspace,
  repositoryLayer,
  turnRepositoryLayer,
  transcriptRepositoryLayer,
  threadSearchRepositoryLayer,
  threadInteractionRepositoryLayer,
  settings = ConfigContract.defaults,
  persistedModelRoutes = [],
  webSearchCredentials = {},
  resolveLegacyRoute,
  globalSettings = {},
  threadToolGateway,
}: ConfiguredBackendOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* mkdir(dirname(filename), { recursive: true })
      const route = ConfigContract.resolveModelRoute(settings, "medium", "main")
      const resolvedOracleRoute = ConfigContract.resolveModelRoute(settings, "medium", "oracle")
      const resolvedCompactionSummaryRoute = ConfigContract.resolveCompactionSummaryRoute(settings)
      const configuredRoutes = defaultModelRoutes(settings)
      const testResponse = yield* Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE"))
      const testScript = yield* Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT"))
      const testMediaAnalyzerResponse = yield* Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE"))
      const testMediaAnalyzerError = yield* Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR"))
      const effectiveConfigForWorkspace = (runtimeWorkspace: string) =>
        Effect.gen(function* () {
          const runtimeSettings = yield* loadSettingsFile(workspacePaths(runtimeWorkspace).settings)
          return yield* ConfigService.effective().pipe(
            provideLayerScoped(
              ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: runtimeSettings,
              }),
            ),
          )
        }).pipe(provideLayerScoped(BunServices.layer))
      if (testResponse._tag === "Some" && testScript._tag === "Some") {
        return yield* ModelConfigurationError.make({
          message: "RIKA_TEST_MODEL_RESPONSE and RIKA_TEST_MODEL_SCRIPT cannot both be set",
        })
      }
      if (testMediaAnalyzerResponse._tag === "Some" && testMediaAnalyzerError._tag === "Some") {
        return yield* ModelConfigurationError.make({
          message: "RIKA_TEST_MEDIA_ANALYZER_RESPONSE and RIKA_TEST_MEDIA_ANALYZER_ERROR cannot both be set",
        })
      }
      let backendKind: "test-script" | "test-response" | "provider"
      if (testScript._tag === "Some") backendKind = "test-script"
      else if (testResponse._tag === "Some") backendKind = "test-response"
      else backendKind = "provider"
      yield* Effect.logInfo("model.backend.configured").pipe(
        Effect.annotateLogs("rika.model.backend.kind", backendKind),
      )
      let registration: ModelProviderRuntime.ModelRegistration
      let selection: ModelProviderRuntime.ModelSelection
      let additionalRegistrations: Array<ModelProviderRuntime.ModelRegistration> = []
      let unavailablePersistedRoutes: ReadonlyArray<PersistedRouteRegistrationFailure> = []
      let modelVariantPolicy: RelayExecutionBackend.ModelVariantPolicy = "registration-key"
      let providerPlans:
        | {
            readonly routePlan: PreparedPlan
            readonly oracleRoutePlan: PreparedPlan
            readonly compactionSummaryPlan: PreparedPlan
          }
        | undefined
      if (testScript._tag === "Some") {
        const fixture = yield* ScriptedModelRuntime.makeScriptedModel(testScript.value)
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else if (testResponse._tag === "Some") {
        const fixture = yield* ScriptedModelRuntime.makeConstantModel(testResponse.value)
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else {
        const runtime = yield* ModelProviderRuntime.Service
        const prepared = yield* runtime
          .prepare(configuredRoutes)
          .pipe(Effect.mapError((error) => ModelConfigurationError.make({ message: error.message })))
        const configuredKeys = new Set(prepared.registrations.map(registrationTuple))
        const persistedRoutesToRestore = persistedModelRoutes.filter((candidate, index, all) => {
          const tuple = registrationTuple(candidate)
          return !configuredKeys.has(tuple) && all.findIndex((other) => registrationTuple(other) === tuple) === index
        })
        const restored = yield* Effect.forEach(
          persistedRoutesToRestore,
          (persistedRoute) =>
            runtime.restoreOne(ModelProviderRuntime.runtimeRouteFromSnapshot(persistedRoute)).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("model.route.persisted.unavailable").pipe(
                        Effect.annotateLogs({
                          "rika.model.alias": persistedRoute.alias,
                          "rika.model.provider": persistedRoute.providerConnection.provider,
                          "rika.model.name": persistedRoute.model,
                          "rika.model.registration_key": persistedRoute.registrationIdentity,
                          "rika.failure.kind": failureKind(cause),
                        }),
                        Effect.as({
                          _tag: "Unavailable" as const,
                          route: persistedRoute,
                          message: causeMessage(cause),
                        }),
                      ),
                onSuccess: (value) => Effect.succeed({ _tag: "Registered" as const, registration: value }),
              }),
            ),
          { concurrency: 1 },
        )
        unavailablePersistedRoutes = restored.flatMap((result) => (result._tag === "Unavailable" ? [result] : []))
        const registrations = [
          ...prepared.registrations,
          ...restored.flatMap((result) => (result._tag === "Registered" ? [result.registration] : [])),
        ]
        const planFor = (resolved: ConfigContract.ResolvedModelRoute) => {
          const index = prepared.routes.findIndex(
            (candidate) =>
              candidate.alias === resolved.alias &&
              candidate.effort === resolved.effort &&
              candidate.fast === resolved.fast,
          )
          if (index < 0) throw new Error(`Missing prepared plan for ${resolved.alias}`)
          return prepared.plans[index]!
        }
        const routePlan = planFor(route)
        const oracleRoutePlan = planFor(resolvedOracleRoute)
        const compactionSummaryPlan = planFor(resolvedCompactionSummaryRoute)
        if (registrations.length === 0)
          return yield* ModelConfigurationError.make({
            message: "No configured model routes could be registered",
          })
        registration = registrations[0]!
        additionalRegistrations = registrations.slice(1)
        selection = routePlan.selection
        providerPlans = { routePlan, oracleRoutePlan, compactionSummaryPlan }
      }
      const backendLayer = relayBackendLayer(
        {
          filename,
          workspace,
          registration,
          ...(additionalRegistrations.length === 0 ? {} : { additionalRegistrations }),
          selection,
          oracleSelection:
            testScript._tag === "Some" || testResponse._tag === "Some"
              ? selection
              : providerPlans!.oracleRoutePlan.selection,
          compactionSummarySelection:
            testScript._tag === "Some" || testResponse._tag === "Some"
              ? selection
              : providerPlans!.compactionSummaryPlan.selection,
          modelVariantPolicy,
          compaction: providerPlans?.routePlan.compaction ?? productionCompaction(route),
          oracleCompaction: providerPlans?.oracleRoutePlan.compaction ?? productionCompaction(resolvedOracleRoute),
          ...(providerPlans === undefined ? {} : { modelResilience: RelayExecutionBackend.defaultModelResilience }),
          toolRuntimeLayerForWorkspace: (runtimeWorkspace) =>
            Layer.unwrap(
              effectiveConfigForWorkspace(runtimeWorkspace).pipe(
                Effect.flatMap((config) => {
                  const credentials = config.environment.webSearchCredentials
                  const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
                  return validateWebSearchProviders(credentials).pipe(
                    Effect.as(
                      ToolRuntime.layerWithProcessRegistry(runtimeWorkspace).pipe(
                        Layer.provide(
                          testMediaAnalyzerResponse._tag === "Some"
                            ? MediaView.analyzerTestLayer(() => Effect.succeed(testMediaAnalyzerResponse.value))
                            : MediaView.analyzerTestLayer(() =>
                                Effect.fail(
                                  MediaView.MediaAnalysisError.make({
                                    message:
                                      testMediaAnalyzerError._tag === "Some"
                                        ? testMediaAnalyzerError.value
                                        : "Media analysis is unavailable",
                                  }),
                                ),
                              ),
                        ),
                        Layer.provide(
                          Layer.merge(
                            WebSearch.factoryLayer(RelayExecutionBackend.webSearchFactories(credentials).factories),
                            ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                          ).pipe(Layer.provide(FetchHttpClient.layer)),
                        ),
                        Layer.provide(BunServices.layer),
                        Layer.catchCause((cause) =>
                          Layer.effectContext(
                            Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) })),
                          ),
                        ),
                      ),
                    ),
                  )
                }),
                Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
              ),
            ),
          resolveWorkspace: (durableExecutionId) =>
            resolveExecutionWorkspace(durableExecutionId, workspace, repositoryLayer, turnRepositoryLayer),
          webSearchCredentials,
        },
        repositoryLayer,
        turnRepositoryLayer,
        transcriptRepositoryLayer,
        threadSearchRepositoryLayer,
        threadInteractionRepositoryLayer,
        threadToolGateway,
      ).pipe(Layer.provide(BunCrypto.layer))
      if (testScript._tag === "Some" || testResponse._tag === "Some") return backendLayer
      return Layer.effect(
        ExecutionBackend.Service,
        ExecutionBackend.Service.pipe(
          Effect.flatMap((backend) =>
            withPinnedRouteRegistration(backend, {
              ...(resolveLegacyRoute === undefined ? {} : { resolveLegacyRoute }),
            }),
          ),
        ),
      ).pipe(Layer.provide(backendLayer))
    }),
  ).pipe(Layer.provide(BunServices.layer))

export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(Effect.mapError((error) => ConfigContract.ConfigFileError.make({ path: filename, message: String(error) })))
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      ConfigContract.ConfigFileError.make({
        path: filename,
        message: `Invalid JSON: ${String(error)}`,
      }),
    ),
  )
  return ConfigContract.decodeSettingsInput(filename, value)
})

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  return typeof failure
}

export const persistedModelRoutesForStartup = (turns: ReadonlyArray<Turn.Turn>) =>
  turns.filter(Turn.isAgentExecution).flatMap((turn) => executionModelRoutes(turn.executionRoute))

const persistedExecutionRouteRow = Schema.Struct({ execution_route_json: Schema.String })
const persistedExecutionRouteJson = Schema.fromJsonString(Turn.ExecutionRoutePin)

export const persistedTitleModelRoutesForStartup = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql`SELECT execution_route_json FROM rika_turns WHERE turn_kind = 'AgentExecution'`
  const routes = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(persistedExecutionRouteRow)(row).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeUnknownEffect(persistedExecutionRouteJson)(decoded.execution_route_json),
      ),
    ),
  )
  return routes.flatMap((route) => (route.title === undefined ? [] : [route.title]))
}).pipe(Effect.withSpan("Main.persistedTitleModelRoutesForStartup"))

export interface ResidentProductEnvironment {
  readonly testModelResponse: Option.Option<string>
  readonly testModelScript: Option.Option<string>
  readonly recoveryAbandon: Option.Option<string>
}

export interface ResidentProductOptions {
  readonly environment: ResidentProductEnvironment
  readonly database: string
  readonly executionDatabase: string
  readonly globalConfig: string
  readonly workspaceConfig: string
  readonly editor: string | undefined
  readonly authOperations: Operation.AuthOperationOptions
  readonly home: string
  readonly workspaceRoot: string
}

const createExtensionLayerImpl = (home: string, workspace: string) => {
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(workspace)
  return Layer.mergeAll(
    ExtensionOperations.layer({
      globalRoot: globalLayout.skills,
      workspaceRoot: workspaceLayout.skills,
      configPath: workspaceLayout.mcpConfig,
      generationsPath: workspaceLayout.extensionGenerations,
    }),
    SkillRegistry.fileSystemLayer,
    McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.hostLayer),
      Layer.provide(McpOAuth.tokenStoreLayer(globalLayout.mcpOAuth)),
    ),
  ).pipe(Layer.provide(BunServices.layer), Layer.merge(BunServices.layer), Layer.merge(FetchHttpClient.layer))
}

export const createExtensionLayer: {
  (workspace: string): (home: string) => ReturnType<typeof createExtensionLayerImpl>
  (home: string, workspace: string): ReturnType<typeof createExtensionLayerImpl>
} = Function.dual(2, createExtensionLayerImpl)

const createOpenAiAuthLayerImpl = (database: string, profileIdentity: string) =>
  OpenAiAuthAdapter.layer.pipe(
    Layer.provide(
      OpenAiCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openai.json"), {
        trustedRoot: dirname(database),
        ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
      }),
    ),
    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
  )

export const createOpenAiAuthLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof createOpenAiAuthLayerImpl>
  (database: string, profileIdentity: string): ReturnType<typeof createOpenAiAuthLayerImpl>
} = Function.dual(2, createOpenAiAuthLayerImpl)

export const createAuthOperations = (options: {
  readonly globalConfig: string
  readonly database: string
  readonly profileIdentity: string
}): Operation.AuthOperationOptions => ({
  layer: createOpenAiAuthLayer(options.database, options.profileIdentity),
  assertOpenAiDirect: (workspace) =>
    Effect.gen(function* () {
      const globalSettings = yield* loadSettingsFile(options.globalConfig)
      const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
      const workspaceConfigLayer = ConfigService.liveEnvironmentLayer({
        webProviders: WebSearch.providerRegistry,
        global: globalSettings,
        workspace: settings,
      })
      const resolved = yield* ConfigService.effective().pipe(provideLayerScoped(workspaceConfigLayer))
      if (resolved.settings.providers.openai?.baseUrl !== ConfigContract.defaults.providers.openai?.baseUrl) {
        return yield* OperationProductError.make({
          message:
            "OpenAI account login cannot be used while providers.openai.baseUrl is customized; remove the override first",
        })
      }
    }).pipe(
      provideLayerScoped(BunServices.layer),
      Effect.mapError((error) =>
        Schema.is(OperationProductError)(error) ? error : OperationProductError.make({ message: String(error) }),
      ),
    ),
})

const runResidentAuthImpl = (
  input: Extract<Operation.Input, { readonly _tag: "Auth" }>,
  options: {
    readonly globalConfig: string
    readonly database: string
    readonly profileIdentity: string
  },
  defaultWorkspace: string,
) => Operation.runAuth(input, createAuthOperations(options), defaultWorkspace)

export const runResidentAuth: {
  (
    options: {
      readonly globalConfig: string
      readonly database: string
      readonly profileIdentity: string
    },
    defaultWorkspace: string,
  ): (input: Extract<Operation.Input, { readonly _tag: "Auth" }>) => ReturnType<typeof runResidentAuthImpl>
  (
    input: Extract<Operation.Input, { readonly _tag: "Auth" }>,
    options: {
      readonly globalConfig: string
      readonly database: string
      readonly profileIdentity: string
    },
    defaultWorkspace: string,
  ): ReturnType<typeof runResidentAuthImpl>
} = Function.dual(3, runResidentAuthImpl)

const createOperationLayerImpl = (
  options: ResidentProductOptions,
  injectedInteractive: (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ) => Effect.Effect<void, Operation.OperationUnavailable>,
) => {
  const {
    environment,
    database,
    executionDatabase,
    globalConfig,
    workspaceConfig,
    editor,
    authOperations,
    home,
    workspaceRoot,
  } = options
  const extensionLayer = createExtensionLayer(home, workspaceRoot)
  const openAiAuthLayer = authOperations.layer
  const productDatabase = Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.all(
        [mkdir(dirname(database), { recursive: true }), mkdir(dirname(executionDatabase), { recursive: true })],
        { concurrency: 2 },
      )
      return Database.layer(database)
    }),
  )
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabase), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadSummaryRepositoryLayer = ThreadSummaryRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const usageRepositoryLayer = UsageRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
  )
  const threadInteractionRepositoryLayer = ThreadInteractionRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
    Layer.catchCause((cause) =>
      Layer.effectContext(
        Effect.fail(ThreadInteractionRepository.RepositoryError.make({ message: Cause.pretty(cause) })),
      ),
    ),
  )
  const threadSearchRepositoryLayer = ThreadSearchRepository.layer.pipe(
    Layer.provide(productDatabase),
    Layer.provide(BunServices.layer),
    Layer.catchCause((cause) =>
      Layer.effectContext(Effect.fail(ThreadSearchRepository.RepositoryError.make({ message: Cause.pretty(cause) }))),
    ),
  )
  const resolvedContextLayer = ResolvedContext.layer(workspaceGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
  return Layer.unwrap(
    Effect.gen(function* () {
      const threadToolGateway = yield* ThreadToolService.makeGateway
      const globalSettings = yield* loadSettingsFile(globalConfig)
      const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
      const applicationConfigLayer = ConfigService.liveEnvironmentLayer({
        webProviders: WebSearch.providerRegistry,
        global: globalSettings,
        workspace: workspaceSettings,
      })
      const effectiveConfig = yield* ConfigService.effective().pipe(provideLayerScoped(applicationConfigLayer))
      const testModelConfigured =
        environment.testModelResponse._tag === "Some" || environment.testModelScript._tag === "Some"
      const providerRuntimeContext = yield* Layer.build(
        testModelConfigured
          ? ModelProviderRuntime.bypassLayer
          : ModelProviderRuntime.Service.layer.pipe(
              Layer.provide(openAiAuthLayer),
              Layer.provide(BedrockAuthRefresh.liveLayer),
            ),
      )
      const modelProviders = Context.get(providerRuntimeContext, ModelProviderRuntime.Service)
      const effectiveConfigForWorkspace = (workspace: string) =>
        Effect.gen(function* () {
          const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
          return yield* ConfigService.effective().pipe(
            provideLayerScoped(
              ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: settings,
              }),
            ),
          )
        }).pipe(provideLayerScoped(BunServices.layer))
      const workspaceExecutionRoutePlan = (
        mode: "low" | "medium" | "high" | "ultra",
        tuning: { readonly fastMode?: boolean } | undefined,
        workspace = process.cwd(),
      ) =>
        Effect.gen(function* () {
          const resolvedWorkspaceConfig = yield* effectiveConfigForWorkspace(workspace)
          const routes = modelRoutesForExecution(resolvedWorkspaceConfig.settings, mode, tuning)
          if (testModelConfigured)
            return {
              routes,
              executionRoute: executionRoutePin(resolvedWorkspaceConfig.settings, mode, tuning),
              registrations: [],
            }
          const prepared = yield* modelProviders.prepare(routes)
          return {
            routes,
            executionRoute: executionRoutePinFromPrepared(mode, prepared),
            registrations: prepared.registrations,
          }
        }).pipe(provideLayerScoped(BunServices.layer))
      const resolveWorkspaceExecutionRoute = (
        mode: "low" | "medium" | "high" | "ultra",
        tuning: { readonly fastMode?: boolean } | undefined,
        workspace = process.cwd(),
      ) =>
        Effect.gen(function* () {
          const resolvedRoute = yield* workspaceExecutionRoutePlan(mode, tuning, workspace)
          return resolvedRoute.executionRoute
        })
      const webSearchCredentials = effectiveConfig.environment.webSearchCredentials
      const repositories = Layer.succeedContext(
        yield* Layer.build(
          Layer.mergeAll(repositoryLayer, turnRepositoryLayer, threadSummaryRepositoryLayer, transcriptRepositoryLayer),
        ),
      )
      const persistedTitleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(
        provideLayerScoped(productDatabase.pipe(Layer.provide(BunServices.layer))),
      )
      const persistedModelRoutes = yield* TurnRepository.Service.pipe(
        Effect.flatMap((turns) => turns.listNonterminal),
        Effect.map((turns) => [...persistedModelRoutesForStartup(turns), ...persistedTitleRoutes]),
        provideLayerScoped(repositories),
      )
      const resolveLegacyRoute = (input: ExecutionBackend.StartInput) =>
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const thread = yield* threads.get(Thread.ThreadId.make(input.threadId))
          if (thread === undefined)
            return yield* ExecutionBackend.BackendError.make({
              message: `Thread ${input.threadId} does not exist for legacy route resolution`,
            })
          const resolved = yield* workspaceExecutionRoutePlan("medium", undefined, thread.workspace)
          return { executionRoute: resolved.executionRoute, registrations: resolved.registrations }
        }).pipe(
          provideLayerScoped(repositories),
          Effect.mapError((error) =>
            Schema.is(ExecutionBackend.BackendError)(error)
              ? error
              : ExecutionBackend.BackendError.make({ message: String(error) }),
          ),
        )
      const backendLayer = configuredBackendLayer({
        filename: executionDatabase,
        workspace: process.cwd(),
        repositoryLayer: repositories,
        turnRepositoryLayer: repositories,
        transcriptRepositoryLayer: repositories,
        threadSearchRepositoryLayer,
        threadInteractionRepositoryLayer,
        settings: effectiveConfig.settings,
        persistedModelRoutes,
        webSearchCredentials,
        resolveLegacyRoute,
        globalSettings,
        threadToolGateway,
      }).pipe(
        Layer.provide(Layer.succeedContext(providerRuntimeContext)),
        Layer.provide(BunServices.layer),
        Layer.provide(BunCrypto.layer),
      )
      const configAdapter = Layer.effect(
        ConfigOperations.Adapter,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return ConfigOperations.Adapter.of({
            exists: (filename) =>
              fileSystem
                .exists(filename)
                .pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: String(error) }))),
            edit: (filename) =>
              Effect.scoped(
                Effect.gen(function* () {
                  if (editor === undefined)
                    return yield* ConfigOperations.AdapterError.make({
                      message: "Set VISUAL or EDITOR to edit configuration",
                    })
                  yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
                  if (!(yield* fileSystem.exists(filename))) yield* fileSystem.writeFileString(filename, "{}\n")
                  const handle = yield* spawner.spawn(ChildProcess.make(editor, [filename]))
                  const code = yield* handle.exitCode
                  if (Number(code) !== 0)
                    return yield* ConfigOperations.AdapterError.make({
                      message: `Editor exited with status ${code}`,
                    })
                }),
              ).pipe(
                Effect.mapError((error) =>
                  Schema.is(ConfigOperations.AdapterError)(error)
                    ? error
                    : ConfigOperations.AdapterError.make({ message: String(error) }),
                ),
              ),
          })
        }),
      )
      const makeThreadId: Effect.Effect<Thread.ThreadId, never, never> = Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.map(Thread.ThreadId.make),
        Effect.orDie,
        provideLayerScoped(BunCrypto.layer),
      )
      const makeTurnId: Effect.Effect<Turn.TurnId, never, never> = Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.map(Turn.TurnId.make),
        Effect.orDie,
        provideLayerScoped(BunCrypto.layer),
      )
      const operationLayer: Layer.Layer<Operation.Service, OperationProductError, never> = Operation.productLayer({
        repositoryLayer: repositories,
        turnRepositoryLayer: repositories,
        threadSummaryRepositoryLayer: repositories,
        transcriptRepositoryLayer: repositories,
        usageRepositoryLayer,
        threadInteractionRepositoryLayer,
        threadToolGateway,
        resolvedContextLayer,
        backendLayer: lazyBackendLayer(backendLayer).pipe(
          Layer.catchCause((cause) =>
            Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
          ),
        ),
        resolveExecutionRoute: (...arguments_) =>
          resolveWorkspaceExecutionRoute(...arguments_).pipe(
            Effect.mapError((error) =>
              OperationProductError.make({
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        toolRuntimeLayer: (workspace) =>
          Layer.unwrap(
            effectiveConfigForWorkspace(workspace).pipe(
              Effect.map((config) => {
                const credentials = config.environment.webSearchCredentials
                const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
                return ToolRuntime.layer(workspace).pipe(
                  Layer.provide(
                    MediaView.analyzerTestLayer(() =>
                      Effect.fail(
                        MediaView.MediaAnalysisError.make({
                          message: "Media analysis is unavailable",
                        }),
                      ),
                    ),
                  ),
                  Layer.provide(
                    Layer.merge(
                      WebSearch.factoryLayer(RelayExecutionBackend.webSearchFactories(credentials).factories),
                      ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                    ).pipe(Layer.provide(FetchHttpClient.layer)),
                  ),
                  Layer.provide(BunServices.layer),
                )
              }),
            ),
          ).pipe(Layer.orDie),
        defaultWorkspace: process.cwd(),
        recoveredWorkGrace: Duration.millis(
          Number(environment.recoveryAbandon._tag === "Some" ? environment.recoveryAbandon.value : "15000"),
        ),
        makeThreadId,
        makeTurnId,
        configOperations: {
          layer: Layer.merge(configAdapter, applicationConfigLayer).pipe(
            Layer.provide(BunServices.layer),
            Layer.catchCause((cause) =>
              Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
            ),
          ),
          options: {
            globalConfigPath: globalConfig,
            workspaceConfigPath: workspaceConfig,
            productDatabasePath: database,
            executionDatabasePath: executionDatabase,
          },
          forWorkspace: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
              return {
                layer: Layer.merge(
                  configAdapter,
                  ConfigService.liveEnvironmentLayer({
                    webProviders: WebSearch.providerRegistry,
                    global: globalSettings,
                    workspace: settings,
                  }),
                ).pipe(
                  Layer.provide(BunServices.layer),
                  Layer.catchCause((cause) =>
                    Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
                  ),
                ),
                options: {
                  globalConfigPath: globalConfig,
                  workspaceConfigPath: workspacePaths(workspace).settings,
                  productDatabasePath: database,
                  executionDatabasePath: executionDatabase,
                },
              }
            }).pipe(
              provideLayerScoped(BunServices.layer),
              Effect.mapError((error) => OperationProductError.make({ message: String(error) })),
            ),
        },
        extensionOperations: {
          layer: extensionLayer as Layer.Layer<
            | ExtensionOperations.Service
            | McpOAuth.Service
            | SkillRegistry.SkillFileSystem
            | FileSystem.FileSystem
            | Path.Path
            | Crypto.Crypto,
            OperationProductError,
            never
          >,
        },
        authOperations,
        interactive: injectedInteractive,
      }).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
        ),
      )
      return operationLayer
    }),
  )
}

export const createOperationLayer: {
  (
    injectedInteractive: (
      input: ResidentService.InteractiveInput,
      session: Operation.InteractiveSession,
    ) => Effect.Effect<void, Operation.OperationUnavailable>,
  ): (options: ResidentProductOptions) => ReturnType<typeof createOperationLayerImpl>
  (
    options: ResidentProductOptions,
    injectedInteractive: (
      input: ResidentService.InteractiveInput,
      session: Operation.InteractiveSession,
    ) => Effect.Effect<void, Operation.OperationUnavailable>,
  ): ReturnType<typeof createOperationLayerImpl>
} = Function.dual(2, createOperationLayerImpl)
