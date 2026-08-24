import type { Redacted } from "effect"
import type { ModelRoute } from "../model-routing/model-route"
import type { McpDefinition } from "./input"
import * as Defaults from "./defaults"
import * as Decoder from "./decoder"
import * as Input from "./input"
import * as ModelRouting from "../model-routing/model-route-resolution"

export interface ConfigurationSettings {
  readonly providers: Readonly<Record<ModelRoute.ProviderId, ModelRoute.ProviderConnection>>
  readonly models: Readonly<Record<string, ModelRoute.ModelAlias>>
  readonly defaultMode: string
  readonly modes: Readonly<Record<string, ModelRoute.ModeConfig>>
  readonly threadTitle: ModelRoute.RoleRoute
  readonly compaction: { readonly summaryModel: ModelRoute.RoleRoute }
  readonly subagents: { readonly maxDepth: number; readonly maxSubagents: number }
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
  readonly diagnostics: ReadonlyArray<import("./diagnostic").ConfigurationDiagnostic>
}

export { Defaults, Decoder, Input, ModelRouting }
