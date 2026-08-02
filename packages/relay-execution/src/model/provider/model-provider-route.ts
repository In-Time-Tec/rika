import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import type { ExecutionRouteModelSnapshot } from "@rika/product/execution-route-snapshot"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { Schema } from "effect"

export interface RuntimeModelRoute {
  readonly role:
    | "main"
    | "oracle"
    | "title"
    | "compaction"
    | "librarian"
    | "painter"
    | "review"
    | "readThread"
    | "surgeon"
    | "task"
  readonly alias: string
  readonly provider: string
  readonly model: string
  readonly registrationKey: string
  readonly providerProtocol: string
  readonly providerBaseUrl: string
  readonly providerApiKeyEnv?: string
  readonly providerRuntime?: {
    readonly adapter: string
    readonly credentialIdentity?: string
    readonly connectionIdentity?: Readonly<Record<string, string>>
  }
  readonly openAiAccountFingerprint?: string
  readonly effort: string
  readonly fast: boolean
  readonly requestVariant: string
  readonly providerOptions?: Readonly<Record<string, unknown>>
  readonly compaction: {
    readonly contextWindow: number
    readonly reserveTokens: number
    readonly keepRecentTokens: number
  }
}

export interface ProviderRuntimePin {
  readonly adapter: string
  readonly credentialIdentity?: string
  readonly connectionIdentity?: Readonly<Record<string, string>>
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("ModelProviderRuntimeError", {
  message: Schema.String,
}) {}

export const runtimeRouteFromSnapshot = (route: ExecutionRouteModelSnapshot): RuntimeModelRoute => ({
  role: route.role,
  alias: route.alias,
  provider: route.providerConnection.provider,
  model: route.model,
  registrationKey: route.registrationIdentity,
  providerProtocol: route.providerConnection.protocol,
  providerBaseUrl: route.providerConnection.baseUrl,
  ...(route.providerConnection.apiKeyEnvironment === undefined
    ? {}
    : { providerApiKeyEnv: route.providerConnection.apiKeyEnvironment }),
  ...(route.providerConnection.authentication === "account" && route.providerConnection.credentialIdentity !== undefined
    ? { openAiAccountFingerprint: route.providerConnection.credentialIdentity }
    : {}),
  effort: route.effort,
  fast: route.fast,
  requestVariant: route.requestVariant,
  ...(route.providerOptions === undefined ? {} : { providerOptions: route.providerOptions }),
  compaction: route.compaction,
})

export const normalizedBaseUrl = (value: string) => {
  const url = new URL(value)
  url.hash = ""
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.toString().replace(/\/(?=\?|$)/, "")
}

export const isNativeOpenAiRoute = (route: ModelRouteResolution.ResolvedModelRoute) =>
  route.providerId === "openai" &&
  route.providerConnection.protocol === "openai" &&
  normalizedBaseUrl(route.providerConnection.baseUrl!) ===
    normalizedBaseUrl(SettingsDefaults.Defaults.defaults.providers.openai!.baseUrl!)
