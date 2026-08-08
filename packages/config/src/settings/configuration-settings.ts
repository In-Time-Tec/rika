import type { Redacted } from "effect"
import type { ModeId } from "../model-routing/behavior-mode"
import type { ModelRoute } from "../model-routing/model-route"
import type { McpDefinition, RoleRouteInput } from "./configuration-settings-input"
import * as Defaults from "./configuration-defaults"
import * as Decoder from "./configuration-settings-decoder"
import * as Input from "./configuration-settings-input"
import * as ModelRouting from "../model-routing/model-route-resolution"

export interface ConfigurationSettings {
  readonly providers: Readonly<Record<ModelRoute.ProviderId, ModelRoute.ProviderConnection>>
  readonly models: Readonly<Record<string, ModelRoute.ModelAlias>>
  readonly modes: Readonly<Record<ModeId, ModelRoute.ModeConfig>>
  readonly threadTitle: ModelRoute.RoleRoute
  readonly agents: Partial<Readonly<Record<ModelRoute.AgentId, RoleRouteInput>>>
  readonly compaction: { readonly summaryModel: ModelRoute.RoleRoute }
  readonly keymap: Readonly<Record<string, string>>
  readonly extensionRoots: ReadonlyArray<string>
  readonly mcp: Readonly<Record<string, McpDefinition>>
  readonly notifications: { readonly enabled: boolean; readonly command?: string }
  readonly logging: { readonly level: "debug" | "info" | "warning" | "error" }
  readonly webSearch: {
    readonly providers: Readonly<Record<string, { readonly configured: true }>>
  }
}

export interface ConfigurationEnvironment {
  readonly providerCredentials: Readonly<Record<string, Redacted.Redacted>>
  readonly webSearchCredentials: Readonly<Record<string, Redacted.Redacted>>
}

export interface EffectiveConfiguration {
  readonly settings: ConfigurationSettings
  readonly environment: ConfigurationEnvironment
  readonly diagnostics: ReadonlyArray<import("./configuration-diagnostic").ConfigurationDiagnostic>
}

export { Defaults, Decoder, Input, ModelRouting }
