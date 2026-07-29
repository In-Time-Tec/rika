#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, Compaction, ModelRegistry, Response as AiResponse } from "@batonfx/core"
import type { TestModel as TestModelTypes } from "@batonfx/test"
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
} from "@rika/app"
import { ConfigContract, ConfigService, Models } from "@rika/config"
import { McpOAuth, SkillRegistry } from "@rika/extensions"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as ThreadInteractionRepository from "@rika/persistence/thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/persistence/thread-search-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as UsageRepository from "@rika/persistence/usage-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { MediaView, ReadWebPage, Runtime as ToolRuntime, ThreadTools, WebSearch, WorkspaceIndex } from "@rika/tools"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  Cause,
  Clock,
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Function,
  Layer,
  Path,
  PlatformError,
  Redacted,
  Ref,
  References,
  Schema,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import * as BedrockAuthRefresh from "./bedrock-auth-refresh"
import { version } from "./command"
import * as Logging from "./logging"
import * as ModelProviderRuntime from "./model-provider-runtime"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"
import { serve as serveResident } from "./resident-host-transport"
import * as ResidentProcessStartup from "./resident-process-startup"
import { modeIds } from "@rika/config/modes"
import { globalPaths, workspacePaths } from "@rika/config/paths"

const pathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const dirname = pathService.dirname
const join = pathService.join

const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

export const terminalTitleSequence: {
  (title: string, workspace: string, workingFrame?: string): string
  (workspace: string): (title: string) => string
} = Function.dual(
  (args) => args.length > 1,
  (title: string, workspace: string, workingFrame?: string): string => {
    const safeWorkingFrame = workingFrame === undefined ? "" : terminalTitleText(workingFrame)
    const prefix = safeWorkingFrame.length === 0 ? "" : `${safeWorkingFrame} `
    return `\u001b]0;${prefix}${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`
  },
)

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

const fffError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FFF",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

const fffGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
    Effect.map((result) => result.items.map((item) => item.relativePath)),
    Effect.mapError((error) => fffError(workspace, error.operation, error)),
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

const testModelPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    params: Schema.Unknown,
    id: Schema.optionalKey(Schema.String),
  }),
])

const testModelUsageSchema = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  outputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})

const testModelTurnSchema = Schema.Union([
  Schema.Struct({
    parts: Schema.NonEmptyArray(testModelPartSchema),
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
  Schema.Struct({
    object: Schema.Unknown,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
  Schema.Struct({
    failure: Schema.String,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
])

const testModelScriptSchema = Schema.NonEmptyArray(testModelTurnSchema)

export const parseTestModelScript = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(testModelScriptSchema))(json)

export const buildTestModelScript: (
  json: string,
) => Effect.Effect<ReadonlyArray<TestModelTypes.Step>, ExternalBoundaryError | Schema.SchemaError> = Effect.fn(
  "Main.buildTestModelScript",
)(function* (json: string) {
  const script = yield* parseTestModelScript(json)
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  return script.map((turn) => {
    const options = {
      ...(turn.delayMs === undefined ? {} : { delay: turn.delayMs }),
      ...(turn.usage === undefined
        ? {}
        : {
            usage: AiResponse.Usage.make({
              inputTokens: {
                uncached: turn.usage.inputTokens,
                total: turn.usage.inputTokens,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: turn.usage.outputTokens,
                text: turn.usage.outputTokens,
                reasoning: undefined,
              },
            }),
          }),
    }
    if ("object" in turn) return TestModel.object(turn.object, options)
    if ("failure" in turn)
      return TestModel.failure(
        AiError.make({
          module: "rika/test-model",
          method: "streamText",
          reason: AiError.UnknownError.make({ description: turn.failure }),
        }),
        options,
      )
    return TestModel.turn(
      turn.parts.map((part) => {
        if (part.type === "text") return TestModel.text(part.text)
        if (part.type === "reasoning") return TestModel.reasoning(part.text)
        return TestModel.toolCall(part.name, part.params, part.id === undefined ? {} : { id: part.id })
      }),
      options,
    )
  })
})

export const makeReloadingTestModel = Effect.fn("Main.makeReloadingTestModel")(function* (path: string) {
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  const load = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const script = yield* fileSystem.readFileString(path)
    return yield* TestModel.make(yield* buildTestModelScript(script))
  })
  const initial = yield* load
  return {
    ...initial,
    registration: {
      ...initial.registration,
      layer: Layer.unwrap(load.pipe(Effect.map((fixture) => fixture.registration.layer))),
    },
  }
})

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
    modes: { ...settings.modes, [mode]: { ...settings.modes[mode], [role]: { ...configured, fast } } },
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
  provider: plan.selection.provider,
  model: plan.selection.model,
  registrationKey: plan.registrationKey,
  providerProtocol: route.providerConnection.protocol,
  providerBaseUrl:
    route.providerConnection.protocol === "amazon-bedrock"
      ? (route.providerConnection.endpoint ?? "bedrock://default")
      : ModelProviderRuntime.normalizedBaseUrl(route.providerConnection.baseUrl),
  ...(route.providerConnection.apiKeyEnv === undefined
    ? {}
    : { providerApiKeyEnv: route.providerConnection.apiKeyEnv }),
  ...(plan.runtime.adapter === "openai-account" && plan.runtime.credentialIdentity !== undefined
    ? { openAiAccountFingerprint: plan.runtime.credentialIdentity }
    : {}),
  providerRuntime: plan.runtime,
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
    agents[agent].registrationKey === (agent === "task" || agent === "surgeon" ? main : oracle).registrationKey
  const allInherited = (Object.keys(agents) as Array<keyof typeof agents>).every(inherited)
  return {
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
        : ModelConfigurationError.make({ message: `Could not resolve model route: ${String(cause)}` }),
  })
})

export const productionCompaction = (
  route?: Pick<ConfigContract.ResolvedModelRoute, "compaction">,
): Compaction.DefaultOptions => ({
  contextWindow: route?.compaction.contextWindow ?? Models.defaultCompaction.contextWindow,
  reserveTokens: route?.compaction.reserveTokens ?? Models.defaultCompaction.reserveTokens,
  keepRecentTokens: route?.compaction.keepRecentTokens ?? Models.defaultCompaction.keepRecentTokens,
})

const registrationTuple = (candidate: {
  readonly provider: string
  readonly model: string
  readonly registrationKey?: string
}) => `${candidate.provider}\0${candidate.model}\0${candidate.registrationKey ?? ""}`

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
  executionModelRoutes(route).some((candidate) => candidate.registrationKey === "legacy-unavailable")

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
      return yield* ExecutionBackend.BackendError.make({ message: `Turn ${turnId} does not exist` })
    const threads = yield* ThreadRepository.Service
    const thread = yield* threads.get(turn.threadId)
    if (thread === undefined)
      return yield* ExecutionBackend.BackendError.make({ message: `Thread ${turn.threadId} does not exist` })
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
    readonly registeredRoutes: ReadonlyArray<{
      readonly provider: string
      readonly model: string
      readonly registrationKey?: string
    }>
    readonly unavailable: ReadonlyArray<PersistedRouteRegistrationFailure>
    readonly registerPinnedRoutes: (
      routes: ReadonlyArray<Turn.ExecutionModelRoute>,
    ) => Effect.Effect<ReadonlyArray<ModelRegistry.Registration>, ModelProviderRuntime.RuntimeError>
    readonly resolveLegacyRoute?: (input: ExecutionBackend.StartInput) => Effect.Effect<
      {
        readonly executionRoute: Turn.ExecutionRoutePin
        readonly registrations: ReadonlyArray<ModelRegistry.Registration>
      },
      ExecutionBackend.BackendError
    >
  },
) {
  const admission = yield* Semaphore.make(1)
  const registered = new Set(options.registeredRoutes.map(registrationTuple))
  const unavailable = new Map(options.unavailable.map((failure) => [registrationTuple(failure.route), failure]))
  const backendRegisterModels = backend.registerModels
  const registerModelsUnlocked =
    backendRegisterModels === undefined
      ? undefined
      : (registrations: ReadonlyArray<ModelRegistry.Registration>) =>
          backendRegisterModels(registrations).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const registration of registrations) registered.add(registrationTuple(registration))
              }),
            ),
          )
  const registerModels =
    registerModelsUnlocked === undefined
      ? undefined
      : (registrations: ReadonlyArray<ModelRegistry.Registration>) =>
          admission.withPermits(1)(
            Effect.gen(function* () {
              const missing = registrations.filter((registration) => !registered.has(registrationTuple(registration)))
              if (missing.length > 0) yield* registerModelsUnlocked(missing)
            }),
          )
  const register = (route: Turn.ExecutionRoutePin) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const missing = executionModelRoutes(route).filter(
          (candidate, index, all) =>
            candidate.providerProtocol !== "test" &&
            !registered.has(registrationTuple(candidate)) &&
            all.findIndex((other) => registrationTuple(other) === registrationTuple(candidate)) === index,
        )
        const blocked = missing.map((candidate) => unavailable.get(registrationTuple(candidate))).find(Boolean)
        if (blocked !== undefined) return yield* unavailableRouteError(blocked)
        if (missing.length === 0) return
        if (registerModelsUnlocked === undefined)
          return yield* ExecutionBackend.BackendError.make({
            message: `Model route ${missing[0]!.alias}/${missing[0]!.effort} is unavailable: the backend cannot register models`,
          })
        const registrations = yield* options.registerPinnedRoutes(missing).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.fail(unavailableRouteError({ route: missing[0]!, message: causeMessage(cause) })),
            onSuccess: Effect.succeed,
          }),
        )
        yield* registerModelsUnlocked(registrations)
        for (const candidate of missing) registered.add(registrationTuple(candidate))
      }),
    )
  return ExecutionBackend.Service.of({
    ...backend,
    ...(registerModels === undefined ? {} : { registerModels }),
    start: (input) =>
      Effect.gen(function* () {
        let resolved
        if (isLegacyUnavailableExecutionRoute(input.executionRoute)) {
          if (options.resolveLegacyRoute === undefined)
            return yield* ExecutionBackend.BackendError.make({
              message: `Turn ${input.turnId} uses the legacy unavailable model route and cannot be started`,
            })
          resolved = yield* options.resolveLegacyRoute(input)
        } else {
          resolved = { executionRoute: input.executionRoute, registrations: [] }
        }
        if (resolved.registrations.length > 0) {
          if (registerModels === undefined)
            return yield* ExecutionBackend.BackendError.make({
              message: `Turn ${input.turnId} resolved a model route that the backend cannot register`,
            })
          yield* registerModels(resolved.registrations)
        }
        yield* register(resolved.executionRoute)
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
      readonly registrations: ReadonlyArray<ModelRegistry.Registration>
    },
    ExecutionBackend.BackendError
  >
  readonly shellPermission?: ConfigContract.PermissionDecision
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
  shellPermission,
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
      const testApprovalTools = yield* Config.option(Config.string("RIKA_TEST_APPROVAL_TOOLS"))
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
      let registration: ModelRegistry.Registration
      let selection: ModelRegistry.ModelSelection
      let additionalRegistrations: Array<ModelRegistry.Registration> = []
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
        const { TestModel } = yield* Effect.tryPromise({
          try: () => import("@batonfx/test"),
          catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
        })
        const fixture = yield* TestModel.make(yield* buildTestModelScript(testScript.value))
        registration = fixture.registration
        selection = fixture.selection
        modelVariantPolicy = "fixed-selection"
      } else if (testResponse._tag === "Some") {
        const { TestModel } = yield* Effect.tryPromise({
          try: () => import("@batonfx/test"),
          catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
        })
        const fixture = yield* TestModel.make(Array.from({ length: 4 }, () => TestModel.text(testResponse.value)))
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
            runtime.restoreOne(persistedRoute).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("model.route.persisted.unavailable").pipe(
                        Effect.annotateLogs({
                          "rika.model.alias": persistedRoute.alias,
                          "rika.model.provider": persistedRoute.provider,
                          "rika.model.name": persistedRoute.model,
                          "rika.model.registration_key": persistedRoute.registrationKey,
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
          return yield* ModelConfigurationError.make({ message: "No configured model routes could be registered" })
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
          ...(shellPermission === undefined
            ? {}
            : {
                permissionPolicy: {
                  rules: [
                    { pattern: "*", level: "allow" },
                    { pattern: "bash", level: shellPermission },
                  ],
                },
              }),
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
          permissionPolicyForExecution: (durableExecutionId) =>
            Effect.gen(function* () {
              const executionWorkspace = yield* resolveExecutionWorkspace(
                durableExecutionId,
                workspace,
                repositoryLayer,
                turnRepositoryLayer,
              )
              const workspaceSettings = yield* loadSettingsFile(workspacePaths(executionWorkspace).settings)
              const layer = ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: workspaceSettings,
              })
              const config = yield* ConfigService.effective().pipe(provideLayerScoped(layer))
              return {
                rules: [
                  { pattern: "*", level: "allow" as const },
                  {
                    pattern: "bash",
                    level: config.settings.permissions.shell ?? ConfigContract.defaults.permissions.shell!,
                  },
                ],
              }
            }).pipe(
              provideLayerScoped(BunServices.layer),
              Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
            ),
          ...(testApprovalTools._tag === "Some" && (testScript._tag === "Some" || testResponse._tag === "Some")
            ? { toolNeedsApproval: (name: string) => testApprovalTools.value.split(",").includes(name) }
            : {}),
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
            ModelProviderRuntime.Service.pipe(
              Effect.flatMap((runtime) =>
                withPinnedRouteRegistration(backend, {
                  registeredRoutes: [registration, ...additionalRegistrations],
                  unavailable: unavailablePersistedRoutes,
                  registerPinnedRoutes: runtime.restore,
                  ...(resolveLegacyRoute === undefined ? {} : { resolveLegacyRoute }),
                }),
              ),
            ),
          ),
        ),
      ).pipe(Layer.provide(backendLayer))
    }),
  ).pipe(Layer.provide(BunServices.layer))

export const lazyBackendLayer = (
  backendLayer: Layer.Layer<ExecutionBackend.Service, Layer.Error<ReturnType<typeof configuredBackendLayer>>>,
) =>
  Layer.effect(
    ExecutionBackend.Service,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const active = yield* Ref.make<ExecutionBackend.Interface | undefined>(undefined)
      const promoter = yield* Ref.make<ExecutionBackend.TurnPromoter | undefined>(undefined)
      const load = yield* Effect.cached(
        Effect.forkIn(
          Layer.buildWithScope(backendLayer, scope).pipe(
            Effect.map((context) => Context.get(context, ExecutionBackend.Service)),
            Effect.tap((backend) => Ref.set(active, backend)),
            Effect.tap((backend) =>
              Ref.get(promoter).pipe(
                Effect.flatMap((registered) =>
                  registered === undefined || backend.registerTurnPromoter === undefined
                    ? Effect.void
                    : backend.registerTurnPromoter(registered),
                ),
              ),
            ),
            Effect.mapError((cause) => ExecutionBackend.BackendError.make({ message: String(cause) })),
          ),
          scope,
        ).pipe(Effect.flatMap(Fiber.join), Effect.uninterruptible),
      )
      return ExecutionBackend.Service.of({
        registerModels: (registrations) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.registerModels === undefined ? Effect.void : backend.registerModels(registrations),
            ),
          ),
        invokeChild: (input) => load.pipe(Effect.flatMap((backend) => backend.invokeChild(input))),
        resolveInvocationSource: (executionId) =>
          load.pipe(Effect.flatMap((backend) => backend.resolveInvocationSource(executionId))),
        createFanOut: (input) => load.pipe(Effect.flatMap((backend) => backend.createFanOut(input))),
        inspectFanOut: (fanOutId) => load.pipe(Effect.flatMap((backend) => backend.inspectFanOut(fanOutId))),
        cancelFanOut: (fanOutId, cancelledAt, reason) =>
          load.pipe(Effect.flatMap((backend) => backend.cancelFanOut(fanOutId, cancelledAt, reason))),
        registerWorkflows: () => load.pipe(Effect.flatMap((backend) => backend.registerWorkflows())),
        startWorkflow: (name, runId, revision, ownerTurnId, workflowWorkspace) =>
          load.pipe(
            Effect.flatMap((backend) => backend.startWorkflow(name, runId, revision, ownerTurnId, workflowWorkspace)),
          ),
        inspectWorkflow: (runId, ownerTurnId, workflowWorkspace) =>
          load.pipe(Effect.flatMap((backend) => backend.inspectWorkflow(runId, ownerTurnId, workflowWorkspace))),
        cancelWorkflow: (runId, ownerTurnId, workflowWorkspace) =>
          load.pipe(Effect.flatMap((backend) => backend.cancelWorkflow(runId, ownerTurnId, workflowWorkspace))),
        wakeThreadHost: (wake) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.wakeThreadHost === undefined ? Effect.void : backend.wakeThreadHost(wake),
            ),
          ),
        registerTurnPromoter: (registered) =>
          Ref.set(promoter, registered).pipe(
            Effect.andThen(Ref.get(active)),
            Effect.flatMap((backend) =>
              backend?.registerTurnPromoter === undefined ? Effect.void : backend.registerTurnPromoter(registered),
            ),
          ),
        start: (input) => load.pipe(Effect.flatMap((backend) => backend.start(input))),
        follow: (turnId, afterCursor, onEvent, reference, eventScope) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.follow === undefined
                ? backend.replay(turnId, afterCursor, reference)
                : backend.follow(turnId, afterCursor, onEvent, reference, eventScope),
            ),
          ),
        replay: (turnId, afterCursor, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.replay(turnId, afterCursor, reference))),
        pageEvents: (turnId, direction, cursor, limit, reference) =>
          load.pipe(
            Effect.flatMap((backend) =>
              backend.pageEvents === undefined
                ? backend
                    .replay(turnId, cursor, reference)
                    .pipe(Effect.map((result) => ({ events: result.events, hasMore: false })))
                : backend.pageEvents(turnId, direction, cursor, limit, reference),
            ),
          ),
        cancel: (turnId, cancelledAt, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.cancel(turnId, cancelledAt, reference))),
        inspect: (turnId, reference) => load.pipe(Effect.flatMap((backend) => backend.inspect(turnId, reference))),
        steer: (turnId, text, idempotencyIdentity, createdAt, reference) =>
          load.pipe(
            Effect.flatMap((backend) => backend.steer(turnId, text, idempotencyIdentity, createdAt, reference)),
          ),
        listApprovals: (turnId, reference) =>
          load.pipe(Effect.flatMap((backend) => backend.listApprovals(turnId, reference))),
        resolveToolApproval: (waitId, approved, resolvedAt, comment) =>
          load.pipe(Effect.flatMap((backend) => backend.resolveToolApproval(waitId, approved, resolvedAt, comment))),
        resolvePermission: (waitId, answer, resolvedAt, reason) =>
          load.pipe(Effect.flatMap((backend) => backend.resolvePermission(waitId, answer, resolvedAt, reason))),
      })
    }),
  )

export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(Effect.mapError((error) => ConfigContract.ConfigFileError.make({ path: filename, message: String(error) })))
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      ConfigContract.ConfigFileError.make({ path: filename, message: `Invalid JSON: ${String(error)}` }),
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
  turns.flatMap((turn) => executionModelRoutes(turn.executionRoute))

const persistedExecutionRouteRow = Schema.Struct({ execution_route_json: Schema.String })
const persistedExecutionRouteJson = Schema.fromJsonString(Turn.ExecutionRoutePin)

export const persistedTitleModelRoutesForStartup = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql`SELECT execution_route_json FROM rika_turns`
  const routes = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(persistedExecutionRouteRow)(row).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeUnknownEffect(persistedExecutionRouteJson)(decoded.execution_route_json),
      ),
    ),
  )
  return routes.flatMap((route) => (route.title === undefined ? [] : [route.title]))
}).pipe(Effect.withSpan("Main.persistedTitleModelRoutesForStartup"))

const start = () => {
  const environment = Effect.runSync(
    Config.all({
      hostDataRoot: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_DATA_ROOT")),
      home: Config.option(Config.string("HOME")),
      database: Config.option(Config.string("RIKA_DATABASE")),
      executionDatabase: Config.option(Config.string("RIKA_EXECUTION_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      testMediaAnalyzerResponse: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE")),
      testMediaAnalyzerError: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR")),
      residentProfile: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_PROFILE")),
      residentGrace: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_GRACE")),
      recoveryAbandon: Config.option(Config.string("RIKA_INTERNAL_RECOVERY_ABANDON")),
      residentStartupHold: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_STARTUP_HOLD")),
    }),
  )
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const defaultDataRoot = `${home}/.rika`
  let database: string
  let executionDatabase: string
  if (hostDataRoot === undefined) {
    database = environment.database._tag === "Some" ? environment.database.value : `${defaultDataRoot}/rika.db`
    executionDatabase =
      environment.executionDatabase._tag === "Some"
        ? environment.executionDatabase.value
        : `${defaultDataRoot}/execution.db`
  } else {
    database = join(hostDataRoot, "rika.db")
    executionDatabase = join(hostDataRoot, "execution.db")
  }
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(process.cwd())
  const globalConfig = globalLayout.settings
  const workspaceConfig = workspaceLayout.settings
  const extensionLayer = Layer.mergeAll(
    ExtensionOperations.layer({
      globalRoot: globalLayout.skills,
      workspaceRoot: workspaceLayout.skills,
      configPath: workspaceLayout.mcpConfig,
      trustPath: globalLayout.mcpTrust,
      generationsPath: workspaceLayout.extensionGenerations,
    }),
    SkillRegistry.fileSystemLayer,
    McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.hostLayer),
      Layer.provide(McpOAuth.tokenStoreLayer(globalLayout.mcpOAuth)),
    ),
  ).pipe(Layer.provide(BunServices.layer), Layer.merge(BunServices.layer), Layer.merge(FetchHttpClient.layer))
  const profile = environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default"
  const profileIdentity = createHash("sha256").update(profile).digest("hex")
  const openAiAuthLayer = OpenAiAuthAdapter.layer.pipe(
    Layer.provide(
      OpenAiCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openai.json"), {
        trustedRoot: dirname(database),
        ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
      }),
    ),
    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
  )
  const authOperations: Operation.AuthOperationOptions = {
    layer: openAiAuthLayer,
    assertOpenAiDirect: (workspace) =>
      Effect.gen(function* () {
        const globalSettings = yield* loadSettingsFile(globalConfig)
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
  }
  let editor: string | undefined
  if (environment.visual._tag === "Some") editor = environment.visual.value
  else if (environment.editor._tag === "Some") editor = environment.editor.value
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
  const resolvedContextLayer = ResolvedContext.layer(fffGlob).pipe(
    Layer.provide(ContextFileSystem.liveLayer),
    Layer.provide(BunServices.layer),
  )
  const operationLayer = (
    injectedInteractive: (
      input: ResidentService.InteractiveInput,
      session: Operation.InteractiveSession,
    ) => Effect.Effect<void, Operation.OperationUnavailable>,
  ) =>
    Layer.unwrap(
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
            if (resolvedRoute.registrations.length > 0) {
              const backend = yield* ExecutionBackend.Service
              if (backend.registerModels !== undefined) yield* backend.registerModels(resolvedRoute.registrations)
            }
            return resolvedRoute.executionRoute
          })
        const webSearchCredentials = effectiveConfig.environment.webSearchCredentials
        const repositories = Layer.succeedContext(
          yield* Layer.build(
            Layer.mergeAll(
              repositoryLayer,
              turnRepositoryLayer,
              threadSummaryRepositoryLayer,
              transcriptRepositoryLayer,
            ),
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
          ...(effectiveConfig.settings.permissions.shell === undefined
            ? {}
            : { shellPermission: effectiveConfig.settings.permissions.shell }),
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
                      return yield* ConfigOperations.AdapterError.make({ message: `Editor exited with status ${code}` })
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
        const product = Operation.productLayer({
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
                        Effect.fail(MediaView.MediaAnalysisError.make({ message: "Media analysis is unavailable" })),
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
          shellPermission: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
              const layer = ConfigService.liveEnvironmentLayer({
                webProviders: WebSearch.providerRegistry,
                global: globalSettings,
                workspace: settings,
              })
              const config = yield* ConfigService.effective().pipe(provideLayerScoped(layer))
              return config.settings.permissions.shell ?? ConfigContract.defaults.permissions.shell!
            }).pipe(provideLayerScoped(BunServices.layer), Effect.orDie),
          makeThreadId: Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
            Effect.map(Thread.ThreadId.make),
            Effect.orDie,
            provideLayerScoped(BunCrypto.layer),
          ),
          makeTurnId: Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
            Effect.map(Turn.TurnId.make),
            Effect.orDie,
            provideLayerScoped(BunCrypto.layer),
          ),
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
          extensionOperations: { layer: extensionLayer },
          authOperations,
          interactive: injectedInteractive,
        })
        return product
      }),
    )
  const residentOwner: ResidentService.Owner = (interactive) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          const loadProduct = yield* Effect.cached(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((startedAt) =>
                Layer.buildWithScope(
                  operationLayer(interactive).pipe(
                    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
                  ),
                  scope,
                ).pipe(
                  Effect.map((context) => Context.get(context, Operation.Service)),
                  Effect.tap(() =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((completedAt) =>
                        Effect.logInfo("resident.product.loaded").pipe(
                          Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
          return Operation.Service.of({
            hasActiveExecutionWork: loadProduct.pipe(
              Effect.flatMap((service) => service.hasActiveExecutionWork ?? Effect.succeed(true)),
              Effect.mapError((error) =>
                Schema.is(Operation.OperationUnavailable)(error)
                  ? error
                  : Operation.OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
              ),
            ),
            authorizeResidentReplacement: loadProduct.pipe(
              Effect.flatMap((service) => service.authorizeResidentReplacement ?? Effect.succeed("defer" as const)),
              Effect.mapError((error) =>
                Schema.is(Operation.OperationUnavailable)(error)
                  ? error
                  : Operation.OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
              ),
            ),
            stopActiveExecutionWork: loadProduct.pipe(
              Effect.flatMap((service) => service.stopActiveExecutionWork ?? Effect.void),
              Effect.mapError((error) =>
                Schema.is(Operation.OperationUnavailable)(error)
                  ? error
                  : Operation.OperationUnavailable.make({ operation: "ResidentAbandonment", message: String(error) }),
              ),
            ),
            run: (input) => {
              if (input._tag === "Auth") return Effect.scoped(Operation.runAuth(input, authOperations, process.cwd()))
              return loadProduct.pipe(
                Effect.flatMap((service) => service.run(input)),
                Effect.mapError((error) =>
                  Schema.is(Operation.OperationUnavailable)(error)
                    ? error
                    : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
                ),
              )
            },
          })
        }),
      ),
    )
  const observedProgram = <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(globalConfig)
              const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
              const effectiveConfig = yield* ConfigService.effective().pipe(
                provideLayerScoped(ConfigService.memoryLayer({ global: globalSettings, workspace: workspaceSettings })),
              )
              return yield* program.pipe(
                Effect.provideService(
                  References.MinimumLogLevel,
                  Logging.minimumLevel(effectiveConfig.settings.logging.level),
                ),
              )
            }),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("process.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
          ),
          Effect.ensuring(Effect.logInfo("process.stopped")),
          Effect.annotateLogs({
            "rika.process.role": role,
            "rika.process.instance": `${startedAt}-${process.pid}`,
            "rika.process.pid": process.pid,
            "rika.version": version,
          }),
        ),
      ),
      provideLayerScoped(
        Layer.merge(
          Logging.layer({ dataRoot, role, version }).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
    )
  const hostProgram =
    hostDataRoot === undefined
      ? Effect.die("Resident host data root is unavailable")
      : Effect.scoped(
          serveResident({
            profile: environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default",
            dataRoot: hostDataRoot,
            graceMilliseconds: Number(
              environment.residentGrace._tag === "Some" ? environment.residentGrace.value : "900000",
            ),
            startupHoldMilliseconds: Number(
              environment.residentStartupHold._tag === "Some" ? environment.residentStartupHold.value : "10000",
            ),
            onReady: ResidentProcessStartup.signalReady,
            owner: residentOwner,
          }),
        ).pipe(
          Effect.tapCause((cause) => {
            const failure = Cause.squash(cause)
            const message =
              failure !== null && typeof failure === "object" && "message" in failure
                ? String(failure.message)
                : String(failure)
            return ResidentProcessStartup.signalFailure(message).pipe(Effect.ignore)
          }),
          provideLayerScoped(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
        )
  BunRuntime.runMain(observedProgram("resident", hostDataRoot ?? defaultDataRoot, hostProgram))
}

if (import.meta.main) start()
