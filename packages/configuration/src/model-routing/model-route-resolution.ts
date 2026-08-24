import { Function, Schema } from "effect"
import type { ModeId } from "./behavior-mode"
import { presets } from "./model-preset"
import type { ModelRoute } from "./model-route"
import type { ConfigurationSettings } from "../settings/model"

export class ModelRouteError extends Schema.TaggedError<ModelRouteError>()("ModelRouteError", {
  mode: Schema.String,
  message: Schema.String,
}) {}

export interface ResolvedModelRoute {
  readonly selection: string
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

const own = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const resolveRoute = (
  settings: ConfigurationSettings,
  route: ModelRoute.RoleRoute,
  owner: string,
): ResolvedModelRoute => {
  const aliasName = "alias" in route ? route.alias : undefined
  const alias = aliasName === undefined ? undefined : own(settings.models, aliasName)
  if (aliasName !== undefined && alias === undefined)
    throw ModelRouteError.make({ mode: owner, message: `${owner} references missing model alias ${aliasName}` })
  const providerId = alias?.provider ?? ("provider" in route ? route.provider : undefined)
  if (providerId === undefined) throw ModelRouteError.make({ mode: owner, message: `${owner} has no provider` })
  const providerConnection = settings.providers[providerId]
  if (providerConnection === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} references missing provider ${providerId}`,
    })
  const preset =
    providerConnection.protocol === "anthropic" || providerConnection.protocol === "amazon-bedrock"
      ? presets.claude
      : presets.openai
  const candidates = alias?.candidates ?? ("model" in route ? [route.model] : [])
  const model = candidates[0]
  if (model === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} has no provider candidates`,
    })
  const variants = alias?.variants[route.effort] ?? {
    normal: { options: {} },
    ...(providerConnection.protocol === "openai-responses" ? { fast: { options: { service_tier: "priority" } } } : {}),
  }
  const variant = route.fast === true ? (variants?.fast ?? variants?.normal) : variants?.normal
  if (variant === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} requests unavailable ${route.effort} variant`,
    })
  const limits = alias?.limits ?? preset.limits
  const contextWindow =
    ("contextWindow" in limits ? limits.contextWindow : undefined) ?? limits.maxInputTokens + limits.maxOutputTokens
  return {
    selection: aliasName ?? model,
    displayName: alias?.displayName ?? model,
    effort: route.effort,
    fast: route.fast === true && variants?.fast !== undefined,
    providerId,
    providerConnection,
    candidates,
    model,
    compaction: {
      contextWindow,
      reserveTokens: contextWindow - limits.maxInputTokens,
      keepRecentTokens: limits.keepRecentTokens,
    },
    maxOutputTokens: limits.maxOutputTokens,
    options: variant.options,
  }
}

export const resolveModelRoute: {
  (mode: ModeId, role?: ModelRoute.Role): (settings: ConfigurationSettings) => ResolvedModelRoute
  (settings: ConfigurationSettings, mode: ModeId, role?: ModelRoute.Role): ResolvedModelRoute
} = Function.dual(
  (args) => typeof args[0] === "object",
  (settings: ConfigurationSettings, mode: ModeId, role: ModelRoute.Role = "main") => {
    const configured = own(settings.modes, mode)
    if (configured === undefined)
      throw ModelRouteError.make({ mode, message: `Mode ${JSON.stringify(mode)} is not configured` })
    return resolveRoute(settings, configured[role], `Mode ${mode} ${role}`)
  },
)

export const agentIds = ["librarian", "painter", "readThread", "review", "surgeon", "task"] as const

const resolveAgentRouteImpl = (
  settings: ConfigurationSettings,
  mode: ModeId,
  agent: ModelRoute.AgentId,
  tuning?: { readonly fastMode?: boolean },
): ResolvedModelRoute => {
  const modeConfig = own(settings.modes, mode)
  if (modeConfig === undefined)
    throw ModelRouteError.make({ mode, message: `Mode ${JSON.stringify(mode)} is not configured` })
  const role = agent === "task" || agent === "surgeon" ? "main" : "oracle"
  const route = modeConfig.agents[agent] ?? modeConfig[role]
  const fast = tuning?.fastMode ?? route.fast ?? false
  return resolveRoute(settings, { ...route, fast }, `Mode ${mode} agent ${agent}`)
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
