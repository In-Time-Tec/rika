import type { ModeId } from "@rika/configuration/behavior-mode"
import type { ModelRoute } from "@rika/configuration/model-route"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import type { ConfigurationSettings } from "@rika/configuration/configuration-settings"
import { dual } from "effect/Function"
import { createHash } from "node:crypto"
import { defaultCompactionSummaryPrompt } from "../contract/execution-compaction-prompt"
import type {
  ExecutionRouteModelCandidateSnapshot,
  ExecutionRouteModelSnapshot,
  ExecutionRouteSnapshot,
} from "../contract/execution-route-snapshot"
import { modelRegistrationIdentity } from "../contract/model-registration-identity"

export interface RouteTuning {
  readonly fastMode?: boolean
  readonly tokenBudget?: number
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

const registrationIdentity = (route: ModelRouteResolution.ResolvedModelRoute, candidateIndex?: number) =>
  modelRegistrationIdentity(
    `rika:model:v2:${createHash("sha256")
      .update(
        canonical({
          alias: route.alias,
          candidates: route.candidates,
          compaction: route.compaction,
          effort: route.effort,
          fast: route.fast,
          maxOutputTokens: route.maxOutputTokens,
          options: route.options,
          provider: route.providerId,
          providerConnection: route.providerConnection,
          ...(candidateIndex === undefined ? {} : { candidateIndex }),
        }),
      )
      .digest("hex")}`,
  )

const providerOptions = (route: ModelRouteResolution.ResolvedModelRoute): Readonly<Record<string, unknown>> => {
  switch (route.providerConnection.protocol) {
    case "openai":
      return { ...route.options, max_output_tokens: route.maxOutputTokens }
    case "anthropic":
      return { ...route.options, max_tokens: route.maxOutputTokens }
    case "amazon-bedrock":
      return { ...route.options, maxTokens: route.maxOutputTokens }
  }
}

const snapshot = (
  route: ModelRouteResolution.ResolvedModelRoute,
  role: ExecutionRouteModelSnapshot["role"],
): ExecutionRouteModelSnapshot => {
  const connection = route.providerConnection
  const providerConnection = {
    provider: route.providerId,
    protocol: connection.protocol,
    baseUrl: connection.protocol === "amazon-bedrock" ? bedrockUrl(connection) : normalizedUrl(connection.baseUrl),
    authentication:
      connection.protocol !== "amazon-bedrock" && connection.apiKeyEnv !== undefined
        ? ("api-key" as const)
        : ("none" as const),
    ...(connection.protocol !== "amazon-bedrock" && connection.apiKeyEnv !== undefined
      ? { apiKeyEnvironment: connection.apiKeyEnv }
      : {}),
  }
  const candidates = route.candidates.map(
    (model, index): ExecutionRouteModelCandidateSnapshot => ({
      model,
      providerConnection,
      registrationIdentity: registrationIdentity(route, index),
      providerOptions: providerOptions(route),
    }),
  ) as ExecutionRouteModelSnapshot["candidates"]
  return {
    role,
    alias: route.alias,
    registrationIdentity: registrationIdentity(route),
    effort: route.effort,
    fast: route.fast,
    candidates,
    compaction: route.compaction,
  }
}

const tunedModeRoute = (settings: ConfigurationSettings, mode: ModeId, role: ModelRoute.Role, tuning?: RouteTuning) => {
  const configured = settings.modes[mode][role]
  return ModelRouteResolution.resolveModelRoute(
    {
      ...settings,
      modes: {
        ...settings.modes,
        [mode]: {
          ...settings.modes[mode],
          [role]: { ...configured, fast: tuning?.fastMode ?? configured.fast ?? false },
        },
      },
    },
    mode,
    role,
  )
}

export const resolve: {
  (mode: ModeId, tuning?: RouteTuning): (settings: ConfigurationSettings) => ExecutionRouteSnapshot
  (settings: ConfigurationSettings, mode: ModeId, tuning?: RouteTuning): ExecutionRouteSnapshot
} = dual(
  (arguments_) => typeof arguments_[0] === "object",
  (settings: ConfigurationSettings, mode: ModeId, tuning?: RouteTuning): ExecutionRouteSnapshot => {
    const main = snapshot(tunedModeRoute(settings, mode, "main", tuning), "main")
    const oracle = snapshot(tunedModeRoute(settings, mode, "oracle", tuning), "oracle")
    const agents = Object.fromEntries(
      ModelRouteResolution.agentIds.map((agent) => [
        agent,
        snapshot(ModelRouteResolution.resolveAgentRoute(settings, mode, agent, tuning), agent),
      ]),
    ) as NonNullable<ExecutionRouteSnapshot["agents"]>
    return {
      version: 2,
      mode,
      ...(tuning?.tokenBudget === undefined ? {} : { tokenBudget: tuning.tokenBudget }),
      compaction: { strategy: "default", summaryPrompt: defaultCompactionSummaryPrompt },
      title: snapshot(ModelRouteResolution.resolveThreadTitleRoute(settings), "title"),
      compactionSummary: snapshot(ModelRouteResolution.resolveCompactionSummaryRoute(settings), "compaction"),
      main,
      oracle,
      agents,
    }
  },
)
