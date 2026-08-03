import * as BehaviorMode from "@rika/configuration/behavior-mode"
import * as ModelRoute from "@rika/configuration/model-route"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import * as ModelProviderRuntime from "../../model/provider/model-provider-runtime"
import { Cause, Context, Effect, Function, Layer, Schema } from "effect"
import { BackendError } from "@rika/product/execution-service"
import { ModelRegistry } from "@batonfx/core"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ScriptedModelRuntime from "../../model/provider/scripted-model-runtime"
import { modeIds } from "@rika/configuration/behavior-mode"

const resolveTunedModeRoute = (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  role: ModelRoute.ModelRoute.Role,
  tuning?: { readonly fastMode?: boolean },
) => {
  const configured = settings.modes[mode][role]
  const fast = tuning?.fastMode ?? configured.fast ?? false
  return ModelRouteResolution.resolveModelRoute(
    {
      ...settings,
      modes: { ...settings.modes, [mode]: { ...settings.modes[mode], [role]: { ...configured, fast } } },
    },
    mode,
    role,
  )
}

const supportingModelRoutes = (settings: SettingsDefaults.ConfigurationSettings) => [
  ModelRouteResolution.resolveThreadTitleRoute(settings),
  ModelRouteResolution.resolveCompactionSummaryRoute(settings),
]

const modelRoutesForExecutionImpl = (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  tuning?: { readonly fastMode?: boolean },
) => [
  resolveTunedModeRoute(settings, mode, "main", tuning),
  resolveTunedModeRoute(settings, mode, "oracle", tuning),
  ...supportingModelRoutes(settings),
  ...ModelRouteResolution.agentIds.map((agent) =>
    ModelRouteResolution.resolveAgentRoute(settings, mode, agent, tuning),
  ),
]

const modelRoutesForExecution: {
  (
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: SettingsDefaults.ConfigurationSettings) => ReturnType<typeof modelRoutesForExecutionImpl>
  (
    settings: SettingsDefaults.ConfigurationSettings,
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ReturnType<typeof modelRoutesForExecutionImpl>
} = Function.dual((args) => typeof args[0] === "object", modelRoutesForExecutionImpl)

const defaultModelRoutes = (settings: SettingsDefaults.ConfigurationSettings) => [
  ...modeIds.flatMap((mode) => [
    ModelRouteResolution.resolveModelRoute(settings, mode, "main"),
    ModelRouteResolution.resolveModelRoute(settings, mode, "oracle"),
  ]),
  ...supportingModelRoutes(settings),
]

type PreparedPlan = ModelProviderRuntime.PreparedRoutes["plans"][number]

const executionModelRoute = (
  route: ModelRouteResolution.ResolvedModelRoute,
  plan: PreparedPlan,
  role: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot["role"],
): ExecutionRouteSnapshot.ExecutionRouteModelSnapshot => {
  let authentication: "account" | "none" | "api-key"
  if (plan.runtime.adapter === "openai-account") authentication = "account"
  else if (route.providerConnection.apiKeyEnv === undefined) authentication = "none"
  else authentication = "api-key"
  return {
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
      authentication,
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnvironment: route.providerConnection.apiKeyEnv }),
      ...(plan.runtime.adapter === "openai-account" ? { credentialIdentity: plan.runtime.credentialIdentity } : {}),
    },
    registrationIdentity: modelRegistrationIdentity(plan.registrationKey),
    effort: route.effort,
    fast: route.fast,
    requestVariant: plan.registrationKey,
    providerOptions: plan.options,
    compaction: route.compaction,
  }
}

const executionRoutePinFromPreparedImpl = (
  mode: BehaviorMode.ModeId,
  prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
): ExecutionRouteSnapshot.ExecutionRoutePin => {
  if (prepared.routes.length !== 10 || prepared.plans.length !== prepared.routes.length)
    throw new Error(`Expected ten prepared execution routes, received ${prepared.routes.length}`)
  const route = (index: number, role: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot["role"]) =>
    executionModelRoute(prepared.routes[index]!, prepared.plans[index]!, role)
  const main = route(0, "main")
  const oracle = route(1, "oracle")
  const agents = {
    librarian: route(4, "librarian"),
    painter: route(5, "painter"),
    review: route(6, "review"),
    readThread: route(7, "readThread"),
    surgeon: route(8, "surgeon"),
    task: route(9, "task"),
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
    title: route(2, "title"),
    compactionSummary: route(3, "compaction"),
    ...(allInherited ? {} : { agents }),
  }
}

const executionRoutePinFromPrepared: {
  (
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): (mode: BehaviorMode.ModeId) => ExecutionRouteSnapshot.ExecutionRoutePin
  (
    mode: BehaviorMode.ModeId,
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): ExecutionRouteSnapshot.ExecutionRoutePin
} = Function.dual(2, executionRoutePinFromPreparedImpl)

const executionRoutePinImpl = (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  tuning?: { readonly fastMode?: boolean },
): ExecutionRouteSnapshot.ExecutionRoutePin => {
  const routes = modelRoutesForExecution(settings, mode, tuning)
  return executionRoutePinFromPrepared(mode, {
    routes,
    plans: routes.map((route) => ModelProviderRuntime.modelRoutePlan(route)),
  })
}

const executionRoutePin: {
  (
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: SettingsDefaults.ConfigurationSettings) => ExecutionRouteSnapshot.ExecutionRoutePin
  (
    settings: SettingsDefaults.ConfigurationSettings,
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ExecutionRouteSnapshot.ExecutionRoutePin
} = Function.dual((args) => typeof args[0] === "object", executionRoutePinImpl)

class RouteResolutionFailure extends Schema.TaggedErrorClass<RouteResolutionFailure>()("RouteResolutionFailure", {
  message: Schema.String,
}) {}

const resolveExecutionRouteForSettings = Effect.fn("Relay.resolveExecutionRouteForSettings")(function* (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  tuning?: { readonly fastMode?: boolean },
) {
  return yield* Effect.try({
    try: () => ({
      routes: modelRoutesForExecution(settings, mode, tuning),
      executionRoute: executionRoutePin(settings, mode, tuning),
    }),
    catch: (cause) =>
      Schema.is(ModelRouteResolution.ModelRouteError)(cause)
        ? cause
        : RouteResolutionFailure.make({ message: `Could not resolve model route: ${String(cause)}` }),
  })
})

const productionCompaction = (route?: Pick<ModelRouteResolution.ResolvedModelRoute, "compaction">) => ({
  contextWindow: route?.compaction.contextWindow ?? SettingsDefaults.Defaults.defaultCompaction.contextWindow,
  reserveTokens: route?.compaction.reserveTokens ?? SettingsDefaults.Defaults.defaultCompaction.reserveTokens,
  keepRecentTokens: route?.compaction.keepRecentTokens ?? SettingsDefaults.Defaults.defaultCompaction.keepRecentTokens,
})

const registrationTuple = (
  candidate:
    | { readonly provider: string; readonly model: string; readonly identity?: string }
    | ExecutionRouteSnapshot.ExecutionRouteModelSnapshot,
) =>
  "providerConnection" in candidate
    ? `${candidate.providerConnection.provider}\0${candidate.model}\0${candidate.registrationIdentity}`
    : `${candidate.provider}\0${candidate.model}\0${candidate.identity ?? ""}`

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return failure instanceof Error ? failure.message : String(failure)
}

interface PreparedExecutionRoutes {
  readonly prepared: ModelProviderRuntime.PreparedRoutes
  readonly registrations: ReadonlyArray<import("@batonfx/core").ModelRegistry.Registration>
  readonly unavailable: ReadonlyArray<{
    readonly route: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot
    readonly message: string
  }>
}

const prepareExecutionRoutes = <ProviderAuthError>(options: {
  readonly routes: ReadonlyArray<ModelRouteResolution.ResolvedModelRoute>
  readonly persisted: ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot>
  readonly providerAuthLayer: Layer.Layer<OpenAiAuth.Service, ProviderAuthError>
}): Effect.Effect<PreparedExecutionRoutes, BackendError, never> =>
  Effect.gen(function* () {
    const service = Context.get(
      yield* Layer.build(
        ModelProviderRuntime.Service.layer.pipe(
          Layer.provide(options.providerAuthLayer),
          Layer.provide(ModelProviderRuntime.bedrockAuthRefreshLiveLayer),
        ),
      ).pipe(Effect.mapError((cause) => BackendError.make({ message: String(cause) }))),
      ModelProviderRuntime.Service,
    )
    const prepared = yield* service
      .prepare(options.routes)
      .pipe(Effect.mapError((cause) => BackendError.make({ message: String(cause) })))
    const configured = new Set(prepared.registrations.map((registration) => registration.registrationKey))
    const restored = yield* Effect.forEach(
      options.persisted.filter((route) => !configured.has(route.registrationIdentity)),
      (route) =>
        service.restoreOne(ModelProviderRuntime.runtimeRouteFromSnapshot(route)).pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed({ _tag: "Unavailable" as const, route, message: String(error) }),
            onSuccess: (registration) => Effect.succeed({ _tag: "Registered" as const, registration }),
          }),
        ),
      { concurrency: 1 },
    )
    return {
      prepared,
      registrations: [
        ...prepared.registrations,
        ...restored.flatMap((entry) => (entry._tag === "Registered" ? [entry.registration] : [])),
      ],
      unavailable: restored.flatMap((entry) => (entry._tag === "Unavailable" ? [entry] : [])),
    }
  }) as never

const testModel = (options: {
  readonly script?: string
  readonly response?: string
}): Effect.Effect<
  { readonly registration: ModelRegistry.Registration; readonly selection: ModelRegistry.ModelSelection },
  BackendError
> => {
  if (options.script !== undefined)
    return ScriptedModelRuntime.makeScriptedModel(options.script).pipe(
      Effect.mapError((cause) => BackendError.make({ message: String(cause) })),
    )
  if (options.response !== undefined)
    return ScriptedModelRuntime.makeConstantModel(options.response).pipe(
      Effect.mapError((cause) => BackendError.make({ message: String(cause) })),
    )
  return BackendError.make({ message: "A test model script or response is required" })
}
export default {
  modelRoutesForExecutionImpl,
  modelRoutesForExecution,
  defaultModelRoutes,
  executionRoutePinFromPreparedImpl,
  executionRoutePinFromPrepared,
  executionRoutePinImpl,
  executionRoutePin,
  resolveExecutionRouteForSettings,
  productionCompaction,
  registrationTuple,
  causeMessage,
  prepareExecutionRoutes,
  testModel,
}
