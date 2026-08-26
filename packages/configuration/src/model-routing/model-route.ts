import type { Schema } from "effect"

export namespace ModelRoute {
  export type Role = "main" | "oracle"
  export type AgentId = "librarian" | "painter" | "readThread" | "review" | "surgeon" | "task"
  export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
  export type ProviderId = "openai" | "anthropic" | "bedrock" | "openrouter"
  export type HttpProtocol = "openai-responses" | "openai-chat-completions" | "anthropic" | "openrouter"

  export interface HttpProviderConnection {
    readonly protocol: HttpProtocol
    readonly baseUrl: string
    readonly apiKeyEnv?: string | undefined
    readonly credentialIdentity?: string | undefined
    readonly streamingOnly?: boolean | undefined
    readonly promptCaching?: boolean | undefined
  }

  export interface BedrockAuthRefresh {
    readonly command: string
    readonly args: ReadonlyArray<string>
  }

  export interface AmazonBedrockProviderConnection {
    readonly protocol: "amazon-bedrock"
    readonly baseUrl?: undefined
    readonly apiKeyEnv?: undefined
    readonly streamingOnly?: undefined
    readonly promptCaching?: undefined
    readonly region?: string
    readonly profile?: string
    readonly endpoint?: string
    readonly authMode: "default" | "bearer"
    readonly authRefresh?: BedrockAuthRefresh
  }

  export type ProviderConnection = HttpProviderConnection | AmazonBedrockProviderConnection

  export interface HttpProviderOverride {
    readonly baseUrl?: string
    readonly apiKeyEnv?: string
    readonly credentialIdentity?: string
    readonly streamingOnly?: boolean
    readonly promptCaching?: boolean
    readonly api?: "responses" | "chat-completions"
  }

  export type ProviderOverride = HttpProviderOverride | Partial<Omit<AmazonBedrockProviderConnection, "protocol">>

  export interface ModelVariant {
    readonly options: Schema.JsonObject
  }

  export interface ModelAlias {
    readonly displayName: string
    readonly supportsMedia: boolean
    readonly provider: ProviderId
    readonly candidates: ReadonlyArray<string>
    readonly limits: {
      readonly contextWindow?: number
      readonly maxInputTokens: number
      readonly maxOutputTokens: number
      readonly keepRecentTokens: number
    }
    readonly variants: Partial<
      Readonly<Record<Effort, { readonly normal: ModelVariant; readonly fast?: ModelVariant }>>
    >
  }

  interface RouteOptions {
    readonly effort: Effort
    readonly fast?: boolean
  }

  export interface DirectModelRoute extends RouteOptions {
    readonly provider: ProviderId
    readonly model: string
    readonly alias?: never
  }

  export interface AliasRoute extends RouteOptions {
    readonly alias: string
    readonly provider?: never
    readonly model?: never
  }

  export type RoleRoute = DirectModelRoute | AliasRoute

  export interface ModeConfig {
    readonly main: RoleRoute
    readonly oracle: RoleRoute
    readonly agents: Partial<Readonly<Record<AgentId, RoleRoute>>>
  }

  export interface SettingsModelRoutes {
    readonly modes: Readonly<Record<string, ModeConfig>>
    readonly threadTitle: RoleRoute
    readonly compaction: { readonly summaryModel: RoleRoute }
  }
}

export const isStreamingOnlyBaseUrl = (baseUrl: string): boolean => {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  return url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")
}
