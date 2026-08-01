import * as BehaviorMode from "@rika/configuration/behavior-mode"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ModelProviderRuntime from "../../../src/model/provider/model-provider-runtime"
import { Function } from "effect"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

const resolveTunedModeRoute = (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  role: "main" | "oracle",
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

const modelRoutesForExecutionEffect = (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  tuning?: { readonly fastMode?: boolean },
) => [
  resolveTunedModeRoute(settings, mode, "main", tuning),
  resolveTunedModeRoute(settings, mode, "oracle", tuning),
  ModelRouteResolution.resolveThreadTitleRoute(settings),
  ModelRouteResolution.resolveCompactionSummaryRoute(settings),
  ...ModelRouteResolution.agentIds.map((agent) =>
    ModelRouteResolution.resolveAgentRoute(settings, mode, agent, tuning),
  ),
]

type PreparedPlan = ModelProviderRuntime.PreparedRoutes["plans"][number]

const executionModelRoute = (
  route: ModelRouteResolution.ResolvedModelRoute,
  plan: PreparedPlan,
  role: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot["role"],
): ExecutionRouteSnapshot.ExecutionRouteModelSnapshot => ({
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
    authentication: (() => {
      if (plan.runtime.adapter === "openai-account") return "account" as const
      return route.providerConnection.apiKeyEnv === undefined ? "none" : "api-key"
    })(),
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
})

const executionRoutePinFromPreparedEffect = (
  mode: BehaviorMode.ModeId,
  prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
): ExecutionRouteSnapshot.ExecutionRoutePin => {
  const { routes, plans } = prepared
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

const executionRoutePinEffect = (
  settings: SettingsDefaults.ConfigurationSettings,
  mode: BehaviorMode.ModeId,
  tuning?: { readonly fastMode?: boolean },
): ExecutionRouteSnapshot.ExecutionRoutePin => {
  const routes = modelRoutesForExecutionEffect(settings, mode, tuning)
  return executionRoutePinFromPreparedEffect(mode, {
    routes,
    plans: routes.map((route) => ModelProviderRuntime.modelRoutePlan(route)),
  })
}

export const modelRoutesForExecution: {
  (
    settings: SettingsDefaults.ConfigurationSettings,
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ReturnType<typeof modelRoutesForExecutionEffect>
  (
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: SettingsDefaults.ConfigurationSettings) => ReturnType<typeof modelRoutesForExecutionEffect>
} = Function.dual((args) => typeof args[0] === "object", modelRoutesForExecutionEffect)

export const executionRoutePinFromPrepared: {
  (
    mode: BehaviorMode.ModeId,
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): ExecutionRouteSnapshot.ExecutionRoutePin
  (
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): (mode: BehaviorMode.ModeId) => ExecutionRouteSnapshot.ExecutionRoutePin
} = Function.dual(2, executionRoutePinFromPreparedEffect)

export const executionRoutePin: {
  (
    settings: SettingsDefaults.ConfigurationSettings,
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ExecutionRouteSnapshot.ExecutionRoutePin
  (
    mode: BehaviorMode.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: SettingsDefaults.ConfigurationSettings) => ExecutionRouteSnapshot.ExecutionRoutePin
} = Function.dual((args) => typeof args[0] === "object", executionRoutePinEffect)

export const executionModelRoutes = (
  route: ExecutionRouteSnapshot.ExecutionRoutePin,
): ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot> => [
  route.main,
  route.oracle,
  ...(route.title === undefined ? [] : [route.title]),
  ...(route.compactionSummary === undefined ? [] : [route.compactionSummary]),
  ...(route.agents === undefined ? [] : Object.values(route.agents)),
]
