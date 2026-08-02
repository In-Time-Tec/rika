import type { ModeId } from "../model-routing/behavior-mode"
import type { ModelRoute } from "../model-routing/model-route"
import type { ConfigurationSettings } from "./configuration-settings"

export interface ModelAliasInput {
  readonly base?: string
  readonly preset?: string
  readonly provider: ModelRoute.ProviderId
  readonly candidates: ReadonlyArray<string>
  readonly displayName?: string
  readonly supportsMedia?: boolean
  readonly limits?: {
    readonly contextWindow?: number
    readonly maxInputTokens: number
    readonly maxOutputTokens: number
    readonly keepRecentTokens: number
  }
  readonly efforts?: Readonly<
    Record<string, { readonly normal: ModelRoute.ModelVariant; readonly fast?: ModelRoute.ModelVariant }>
  >
}

export interface RoleRouteInput {
  readonly alias: string
  readonly effort?: ModelRoute.Effort
  readonly fast?: boolean
}

export interface ModelRoutesInput {
  readonly modes?: Partial<
    Readonly<Record<ModeId, Partial<Readonly<Record<ModelRoute.Role, string | RoleRouteInput>>>>>
  >
  readonly title?: string | RoleRouteInput
  readonly agents?: Partial<Readonly<Record<ModelRoute.AgentId, string | RoleRouteInput>>>
  readonly compaction?: string | RoleRouteInput
}

export interface McpCommandDefinition {
  readonly transport: "command"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string>>
  readonly enabled: boolean
}

export interface McpRemoteDefinition {
  readonly transport: "remote"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly enabled: boolean
}

export type McpDefinition = McpCommandDefinition | McpRemoteDefinition

export interface ConfigurationSettingsInput {
  readonly providers?: Partial<Readonly<Record<ModelRoute.ProviderId, ModelRoute.ProviderOverride>>>
  readonly modelAliases?: Readonly<Record<string, ModelAliasInput>>
  readonly modelRoutes?: ModelRoutesInput
  readonly keymap?: Readonly<Record<string, string>>
  readonly extensionRoots?: ReadonlyArray<string>
  readonly mcp?: Readonly<Record<string, McpDefinition>>
  readonly notifications?: Partial<ConfigurationSettings["notifications"]>
  readonly logging?: Partial<ConfigurationSettings["logging"]>
  readonly webSearch?: {
    readonly providers: Readonly<Record<string, { readonly apiKey: string }>>
  }
}

export type SettingsInput = ConfigurationSettingsInput
