import type { ModeId } from "@rika/configuration/behavior-mode"
import type { ModelRoute } from "@rika/configuration/model-route"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import { Defaults, type ConfigurationSettings } from "@rika/configuration/configuration-settings"
import { dual } from "effect/Function"
import { createHash } from "node:crypto"
import { defaultCompactionSummaryPrompt } from "../contract/execution-compaction-prompt"
import type {
  ExecutionRouteModelCandidateSnapshot,
  ExecutionRouteModelSnapshot,
  ExecutionRouteSnapshot,
} from "../contract/execution-route-snapshot"
import { modelRegistrationIdentity } from "../contract/model-registration-identity"
import type { ProviderConnectionSnapshot } from "../contract/provider-connection-snapshot"

export interface RouteTuning {
  readonly fastMode?: boolean
  readonly tokenBudget?: number
}

export interface RouteAuthentication {
  readonly openAiAccount?: {
    readonly credentialIdentity: string
    readonly fingerprint: string
  }
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`
}

const normalizedUrl = (value: string): string => {
  const url = new URL(value)
  url.hash = ""
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.toString().replace(/\/(?=\?|$)/, "")
}

const bedrockUrl = (connection: ModelRoute.AmazonBedrockProviderConnection): string => {
  const url = new URL(connection.endpoint ?? "bedrock://default")
  if (connection.region !== undefined) url.searchParams.set("region", connection.region)
  if (connection.profile !== undefined) url.searchParams.set("profile", connection.profile)
  url.searchParams.set("authMode", connection.authMode)
  return url.toString()
}

const openAiAccount = (
  route: ModelRouteResolution.ResolvedModelRoute,
  authentication: RouteAuthentication | undefined,
): RouteAuthentication["openAiAccount"] =>
  route.providerId === "openai" &&
  route.providerConnection.protocol === "openai-responses" &&
  normalizedUrl(route.providerConnection.baseUrl) === normalizedUrl(Defaults.providerDefaults.openai.baseUrl)
    ? authentication?.openAiAccount
    : undefined

const connectionSnapshot = (
  route: ModelRouteResolution.ResolvedModelRoute,
  authentication: RouteAuthentication | undefined,
): ProviderConnectionSnapshot => {
  const connection = route.providerConnection
  const account = openAiAccount(route, authentication)
  if (account !== undefined && connection.protocol === "openai-responses") {
    return {
      provider: route.providerId,
      protocol: connection.protocol,
      baseUrl: normalizedUrl(connection.baseUrl),
      authentication: "account",
      credentialIdentity: account.credentialIdentity,
      accountFingerprint: account.fingerprint,
    }
  }
  return {
    provider: route.providerId,
    protocol: connection.protocol,
    baseUrl: connection.protocol === "amazon-bedrock" ? bedrockUrl(connection) : normalizedUrl(connection.baseUrl),
    authentication: connection.protocol !== "amazon-bedrock" && connection.apiKeyEnv !== undefined ? "api-key" : "none",
    ...(connection.protocol !== "amazon-bedrock" && connection.apiKeyEnv !== undefined
      ? { apiKeyEnvironment: connection.apiKeyEnv }
      : {}),
    ...(connection.protocol !== "amazon-bedrock" && connection.credentialIdentity !== undefined
      ? { credentialIdentity: connection.credentialIdentity }
      : {}),
  }
}

const providerOptions = (
  route: ModelRouteResolution.ResolvedModelRoute,
  authentication: ProviderConnectionSnapshot["authentication"],
): Readonly<Record<string, unknown>> => {
  switch (route.providerConnection.protocol) {
    case "openai-responses": {
      if (authentication === "account") {
        const { max_output_tokens: _, ...options } = route.options
        return { ...options, store: false }
      }
      return { ...route.options, max_output_tokens: route.maxOutputTokens }
    }
    case "openai-chat-completions":
      return { ...route.options, max_tokens: route.maxOutputTokens }
    case "anthropic":
      return { ...route.options, max_tokens: route.maxOutputTokens }
    case "openrouter":
      return { ...route.options, max_tokens: route.maxOutputTokens }
    case "amazon-bedrock":
      return { ...route.options, maxTokens: route.maxOutputTokens }
  }
}

const registrationIdentity = (
  route: ModelRouteResolution.ResolvedModelRoute,
  providerConnection: ProviderConnectionSnapshot,
  options: Readonly<Record<string, unknown>>,
  candidateIndex?: number,
) =>
  modelRegistrationIdentity(
    `rika:model:v1:${createHash("sha256")
      .update(
        canonical({
          selection: route.selection,
          candidates: route.candidates,
          compaction: route.compaction,
          effort: route.effort,
          fast: route.fast,
          options,
          provider: route.providerId,
          providerConnection,
          ...(candidateIndex === undefined ? {} : { candidateIndex }),
        }),
      )
      .digest("hex")}`,
  )

const snapshot = (
  route: ModelRouteResolution.ResolvedModelRoute,
  role: ExecutionRouteModelSnapshot["role"],
  authentication: RouteAuthentication | undefined,
): ExecutionRouteModelSnapshot => {
  const providerConnection = connectionSnapshot(route, authentication)
  const options = providerOptions(route, providerConnection.authentication)
  const candidates = route.candidates.map(
    (model, index): ExecutionRouteModelCandidateSnapshot => ({
      model,
      providerConnection,
      registrationIdentity: registrationIdentity(route, providerConnection, options, index),
      providerOptions: options,
    }),
  ) as ExecutionRouteModelSnapshot["candidates"]
  return {
    role,
    selection: route.selection,
    registrationIdentity: registrationIdentity(route, providerConnection, options),
    effort: route.effort,
    fast: route.fast,
    candidates,
    compaction: route.compaction,
  }
}

const tunedModeRoute = (settings: ConfigurationSettings, mode: ModeId, role: ModelRoute.Role, tuning?: RouteTuning) => {
  const modeConfig = settings.modes[mode]
  const configured = modeConfig?.[role]
  if (configured === undefined || modeConfig === undefined)
    return ModelRouteResolution.resolveModelRoute(settings, mode, role)
  return ModelRouteResolution.resolveModelRoute(
    {
      ...settings,
      modes: {
        ...settings.modes,
        [mode]: {
          ...modeConfig,
          [role]: { ...configured, fast: tuning?.fastMode ?? configured.fast ?? false },
        },
      },
    },
    mode,
    role,
  )
}

export const resolve: {
  (
    mode: ModeId,
    tuning?: RouteTuning,
    authentication?: RouteAuthentication,
  ): (settings: ConfigurationSettings) => ExecutionRouteSnapshot
  (
    settings: ConfigurationSettings,
    mode: ModeId,
    tuning?: RouteTuning,
    authentication?: RouteAuthentication,
  ): ExecutionRouteSnapshot
} = dual(
  (arguments_) => typeof arguments_[0] === "object",
  (
    settings: ConfigurationSettings,
    mode: ModeId,
    tuning?: RouteTuning,
    authentication?: RouteAuthentication,
  ): ExecutionRouteSnapshot => {
    const main = snapshot(tunedModeRoute(settings, mode, "main", tuning), "main", authentication)
    const oracle = snapshot(tunedModeRoute(settings, mode, "oracle", tuning), "oracle", authentication)
    const agents = Object.fromEntries(
      ModelRouteResolution.agentIds.map((agent) => [
        agent,
        snapshot(ModelRouteResolution.resolveAgentRoute(settings, mode, agent, tuning), agent, authentication),
      ]),
    ) as NonNullable<ExecutionRouteSnapshot["agents"]>
    return {
      version: 3,
      mode,
      ...(tuning?.tokenBudget === undefined ? {} : { tokenBudget: tuning.tokenBudget }),
      subagents: settings.subagents,
      compaction: { strategy: "default", summaryPrompt: defaultCompactionSummaryPrompt },
      title: snapshot(ModelRouteResolution.resolveThreadTitleRoute(settings), "title", authentication),
      compactionSummary: snapshot(
        ModelRouteResolution.resolveCompactionSummaryRoute(settings),
        "compaction",
        authentication,
      ),
      main,
      oracle,
      agents,
    }
  },
)
