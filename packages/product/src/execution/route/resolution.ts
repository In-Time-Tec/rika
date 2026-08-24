import type { ModeId } from "@rika/configuration/behavior-mode"
import type { ModelRoute } from "@rika/configuration/model-route"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import { Defaults, type ConfigurationSettings } from "@rika/configuration/configuration-settings"
import { Schema } from "effect"
import { dual } from "effect/Function"
import { createHash } from "node:crypto"
import { defaultCompactionSummaryPrompt } from "../compaction/prompt"
import type {
  ExecutionRouteModelCandidateSnapshot,
  ExecutionRouteModelSnapshot,
  ExecutionRouteSnapshot,
} from "./snapshot"
import { modelRegistrationIdentity } from "../model/registration-identity"
import type { ProviderConnectionSnapshot } from "../model/provider-connection"

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

const canonical = (value: Schema.Json): string => {
  if (!Schema.is(Schema.JsonObject)(value) && !Array.isArray(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
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
  const snapshot = {
    provider: route.providerId,
    protocol: connection.protocol,
    baseUrl: connection.protocol === "amazon-bedrock" ? bedrockUrl(connection) : normalizedUrl(connection.baseUrl),
    authentication: connection.protocol !== "amazon-bedrock" && connection.apiKeyEnv !== undefined ? "api-key" : "none",
  } satisfies ProviderConnectionSnapshot
  if (connection.protocol !== "amazon-bedrock" && connection.apiKeyEnv !== undefined) {
    if (connection.credentialIdentity !== undefined)
      return {
        ...snapshot,
        apiKeyEnvironment: connection.apiKeyEnv,
        credentialIdentity: connection.credentialIdentity,
      }
    return { ...snapshot, apiKeyEnvironment: connection.apiKeyEnv }
  }
  if (connection.protocol !== "amazon-bedrock" && connection.credentialIdentity !== undefined)
    return { ...snapshot, credentialIdentity: connection.credentialIdentity }
  return snapshot
}

const providerOptions = (
  route: ModelRouteResolution.ResolvedModelRoute,
  authentication: ProviderConnectionSnapshot["authentication"],
): NonNullable<ExecutionRouteModelCandidateSnapshot["providerOptions"]> => {
  let providerOptionValues
  switch (route.providerConnection.protocol) {
    case "openai-responses": {
      if (authentication === "account") {
        const { max_output_tokens: _, ...options } = route.options
        return Schema.decodeSync(Schema.JsonObject)({ ...options, store: false })
      }
      providerOptionValues = { ...route.options, max_output_tokens: route.maxOutputTokens }
      break
    }
    case "openai-chat-completions":
      providerOptionValues = { ...route.options, max_tokens: route.maxOutputTokens }
      break
    case "anthropic":
      providerOptionValues = { ...route.options, max_tokens: route.maxOutputTokens }
      break
    case "openrouter":
      providerOptionValues = { ...route.options, max_tokens: route.maxOutputTokens }
      break
    case "amazon-bedrock":
      providerOptionValues = { ...route.options, maxTokens: route.maxOutputTokens }
      break
  }
  return Schema.decodeSync(Schema.JsonObject)(providerOptionValues)
}

const registrationIdentity = (
  route: ModelRouteResolution.ResolvedModelRoute,
  providerConnection: ProviderConnectionSnapshot,
  options: NonNullable<ExecutionRouteModelCandidateSnapshot["providerOptions"]>,
  candidateIndex?: number,
) => {
  const identity = {
    selection: route.selection,
    candidates: route.candidates,
    compaction: route.compaction,
    effort: route.effort,
    fast: route.fast,
    options,
    provider: route.providerId,
    providerConnection,
  }
  const canonicalIdentity: Schema.JsonObject = Schema.decodeUnknownSync(Schema.JsonObject)(identity)
  const identityValue = candidateIndex === undefined ? canonicalIdentity : { ...canonicalIdentity, candidateIndex }
  return modelRegistrationIdentity(
    `rika:model:v1:${createHash("sha256").update(canonical(identityValue)).digest("hex")}`,
  )
}

const snapshot = (
  route: ModelRouteResolution.ResolvedModelRoute,
  role: ExecutionRouteModelSnapshot["role"],
  authentication: RouteAuthentication | undefined,
): ExecutionRouteModelSnapshot => {
  const providerConnection = connectionSnapshot(route, authentication)
  const options = providerOptions(route, providerConnection.authentication)
  const candidates: ExecutionRouteModelSnapshot["candidates"] = route.candidates.map(
    (model, index): ExecutionRouteModelCandidateSnapshot => ({
      model,
      providerConnection,
      registrationIdentity: registrationIdentity(route, providerConnection, options, index),
      providerOptions: options,
    }),
  )
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
  (arguments_) => Schema.is(Schema.Struct({ providers: Schema.Unknown }))(arguments_[0]),
  (
    settings: ConfigurationSettings,
    mode: ModeId,
    tuning?: RouteTuning,
    authentication?: RouteAuthentication,
  ): ExecutionRouteSnapshot => {
    const main = snapshot(tunedModeRoute(settings, mode, "main", tuning), "main", authentication)
    const oracle = snapshot(tunedModeRoute(settings, mode, "oracle", tuning), "oracle", authentication)
    const agents: ExecutionRouteSnapshot["agents"] = {
      librarian: snapshot(
        ModelRouteResolution.resolveAgentRoute(settings, mode, "librarian", tuning),
        "librarian",
        authentication,
      ),
      painter: snapshot(
        ModelRouteResolution.resolveAgentRoute(settings, mode, "painter", tuning),
        "painter",
        authentication,
      ),
      readThread: snapshot(
        ModelRouteResolution.resolveAgentRoute(settings, mode, "readThread", tuning),
        "readThread",
        authentication,
      ),
      review: snapshot(
        ModelRouteResolution.resolveAgentRoute(settings, mode, "review", tuning),
        "review",
        authentication,
      ),
      surgeon: snapshot(
        ModelRouteResolution.resolveAgentRoute(settings, mode, "surgeon", tuning),
        "surgeon",
        authentication,
      ),
      task: snapshot(ModelRouteResolution.resolveAgentRoute(settings, mode, "task", tuning), "task", authentication),
    }
    const executionRoute = {
      version: 3,
      mode,
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
    } satisfies ExecutionRouteSnapshot
    if (tuning?.tokenBudget !== undefined) return { ...executionRoute, tokenBudget: tuning.tokenBudget }
    return executionRoute
  },
)
