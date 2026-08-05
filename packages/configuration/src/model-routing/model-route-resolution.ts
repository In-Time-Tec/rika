import { Function, Schema } from "effect"
import type { ModeId } from "./behavior-mode"
import type { ModelRoute } from "./model-route"
import type { ConfigurationSettings } from "../settings/configuration-settings"

export class ModelRouteError extends Schema.TaggedErrorClass<ModelRouteError>()("ModelRouteError", {
  mode: Schema.String,
  message: Schema.String,
}) {}

export interface ResolvedModelRoute {
  readonly alias: string
  readonly displayName: string
  readonly effort: ModelRoute.Effort
  readonly fast: boolean
  readonly providerId: ModelRoute.ProviderId
  readonly providerConnection: ModelRoute.ProviderConnection
  readonly candidates: ReadonlyArray<string>
  readonly model: string
  readonly compaction: {
    readonly contextWindow: number
    readonly reserveTokens: number
    readonly keepRecentTokens: number
  }
  readonly maxOutputTokens: number
  readonly options: Readonly<Record<string, unknown>>
}

const resolveRoute = (
  settings: ConfigurationSettings,
  route: ModelRoute.RoleRoute,
  owner: string,
): ResolvedModelRoute => {
  const alias = settings.models[route.alias]
  if (alias === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} references missing model alias ${route.alias}`,
    })
  const providerConnection = settings.providers[alias.provider]
  if (providerConnection === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} model alias ${route.alias} references missing provider ${alias.provider}`,
    })
  const model = alias.candidates[0]
  if (model === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} model alias ${route.alias} has no provider candidates`,
    })
  const variant = alias.variants[route.effort]?.[route.fast === true ? "fast" : "normal"]
  if (variant === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} requests unavailable ${route.alias}/${route.effort}${route.fast === true ? "/fast" : ""} variant`,
    })
  return {
    alias: route.alias,
    displayName: alias.displayName,
    effort: route.effort,
    fast: route.fast === true,
    providerId: alias.provider,
    providerConnection,
    candidates: alias.candidates,
    model,
    compaction: {
      contextWindow: alias.limits.contextWindow ?? alias.limits.maxInputTokens + alias.limits.maxOutputTokens,
      reserveTokens:
        (alias.limits.contextWindow ?? alias.limits.maxInputTokens + alias.limits.maxOutputTokens) -
        alias.limits.maxInputTokens,
      keepRecentTokens: alias.limits.keepRecentTokens,
    },
    maxOutputTokens: alias.limits.maxOutputTokens,
    options: variant.options,
  }
}

export const resolveModelRoute: {
  (mode: ModeId, role?: ModelRoute.Role): (settings: ConfigurationSettings) => ResolvedModelRoute
  (settings: ConfigurationSettings, mode: ModeId, role?: ModelRoute.Role): ResolvedModelRoute
} = Function.dual(
  (args) => typeof args[0] === "object",
  (settings: ConfigurationSettings, mode: ModeId, role: ModelRoute.Role = "main") =>
    resolveRoute(settings, settings.modes[mode][role], `Mode ${mode} ${role}`),
)

export const agentIds = ["librarian", "painter", "readThread", "review", "surgeon", "task"] as const

const resolveAgentRouteImpl = (
  settings: ConfigurationSettings,
  mode: ModeId,
  agent: ModelRoute.AgentId,
  tuning?: { readonly fastMode?: boolean },
): ResolvedModelRoute => {
  const role = agent === "task" || agent === "surgeon" ? "main" : "oracle"
  const inherited = settings.modes[mode][role]
  const configured = settings.agents[agent]
  const fast = tuning?.fastMode ?? configured?.fast ?? inherited.fast ?? false
  if (configured === undefined) return resolveRoute(settings, { ...inherited, fast }, `Agent ${agent}`)
  return resolveRoute(
    settings,
    { alias: configured.alias, effort: configured.effort ?? inherited.effort, fast },
    `Agent ${agent}`,
  )
}

export const resolveAgentRoute: {
  (
    mode: ModeId,
    agent: ModelRoute.AgentId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigurationSettings) => ResolvedModelRoute
  (
    settings: ConfigurationSettings,
    mode: ModeId,
    agent: ModelRoute.AgentId,
    tuning?: { readonly fastMode?: boolean },
  ): ResolvedModelRoute
} = Function.dual((args) => typeof args[0] === "object", resolveAgentRouteImpl)

export const resolveThreadTitleRoute = (settings: ConfigurationSettings): ResolvedModelRoute =>
  resolveRoute(settings, settings.threadTitle, "Thread title model")

export const resolveCompactionSummaryRoute = (settings: ConfigurationSettings): ResolvedModelRoute =>
  resolveRoute(settings, settings.compaction.summaryModel, "Compaction summary model")
