import { Function, Schema, type Redacted } from "effect"
import { defaults as modelDefaults } from "./models"

export type ModeId = "low" | "medium" | "high" | "ultra"
export type Role = "main" | "oracle"
export type AgentId = "librarian" | "painter" | "review" | "readThread" | "task"
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type PermissionDecision = "allow" | "ask" | "deny"
export type LogLevel = "debug" | "info" | "warning" | "error"

export type ProviderId = "openai" | "anthropic"
export interface ProviderConnection {
  readonly protocol: ProviderId
  readonly baseUrl: string
  readonly apiKeyEnv?: string | undefined
}
export interface ProviderOverride {
  readonly baseUrl?: string
  readonly apiKeyEnv?: string
}

export interface ModelVariant {
  readonly options: Readonly<Record<string, unknown>>
}

export interface ModelAlias {
  readonly provider: ProviderId
  readonly candidates: ReadonlyArray<string>
  readonly limits: {
    readonly maxInputTokens: number
    readonly maxOutputTokens: number
    readonly keepRecentTokens: number
  }
  readonly variants: Partial<Readonly<Record<Effort, { readonly normal: ModelVariant; readonly fast?: ModelVariant }>>>
}

export interface RoleRoute {
  readonly alias: string
  readonly effort: Effort
  readonly fast?: boolean
}

export interface ModeConfig {
  readonly main: RoleRoute
  readonly oracle: RoleRoute
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

export interface Settings {
  readonly providers: Readonly<Record<ProviderId, ProviderConnection>>
  readonly models: Readonly<Record<string, ModelAlias>>
  readonly modes: Readonly<Record<ModeId, ModeConfig>>
  readonly agents: Readonly<Record<AgentId, RoleRoute>>
  readonly compaction: { readonly summaryModel: RoleRoute }
  readonly keymap: Readonly<Record<string, string>>
  readonly permissions: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots: ReadonlyArray<string>
  readonly mcp: Readonly<Record<string, McpDefinition>>
  readonly notifications: { readonly enabled: boolean; readonly command?: string }
  readonly logging: { readonly level: LogLevel }
}

export interface SettingsInput {
  readonly providers?: Partial<Readonly<Record<ProviderId, ProviderOverride>>>
  readonly keymap?: Readonly<Record<string, string>>
  readonly permissions?: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots?: ReadonlyArray<string>
  readonly mcp?: Readonly<Record<string, McpDefinition>>
  readonly notifications?: Partial<Settings["notifications"]>
  readonly logging?: Partial<Settings["logging"]>
}

export interface Environment {
  readonly providerCredentials: Readonly<Record<string, Redacted.Redacted>>
  readonly parallelApiKey?: Redacted.Redacted
}

export interface Diagnostic {
  readonly path: string
  readonly source: "default" | "global" | "workspace" | "environment"
  readonly message: string
}

export interface EffectiveConfig {
  readonly settings: Settings
  readonly environment: Environment
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

export class ConfigFileError extends Schema.TaggedErrorClass<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ModelRouteError extends Schema.TaggedErrorClass<ModelRouteError>()("ModelRouteError", {
  mode: Schema.String,
  message: Schema.String,
}) {}

export interface ResolvedModelRoute {
  readonly alias: string
  readonly effort: Effort
  readonly fast: boolean
  readonly providerId: ProviderId
  readonly providerConnection: ProviderConnection
  readonly candidates: ReadonlyArray<string>
  readonly model: string
  readonly compaction: {
    readonly contextWindow: number
    readonly reserveTokens: number
    readonly keepRecentTokens: number
  }
  readonly options: Readonly<Record<string, unknown>>
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const exactKeys = (path: string, label: string, value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw ConfigFileError.make({ path, message: `${label} contains unknown key ${unknown}` })
}

const resolveRoute = (settings: Settings, route: RoleRoute, owner: string): ResolvedModelRoute => {
  const alias = settings.models[route.alias]
  if (alias === undefined)
    throw ModelRouteError.make({ mode: owner, message: `${owner} references missing model alias ${route.alias}` })
  const providerConnection = settings.providers[alias.provider]!
  const variant = alias.variants[route.effort]?.[route.fast === true ? "fast" : "normal"]
  if (variant === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} requests unavailable ${route.alias}/${route.effort}${route.fast === true ? "/fast" : ""} variant`,
    })
  return {
    alias: route.alias,
    effort: route.effort,
    fast: route.fast === true,
    providerId: alias.provider,
    providerConnection,
    candidates: alias.candidates,
    model: alias.candidates[0]!,
    compaction: {
      contextWindow: alias.limits.maxInputTokens + alias.limits.maxOutputTokens,
      reserveTokens: alias.limits.maxOutputTokens,
      keepRecentTokens: alias.limits.keepRecentTokens,
    },
    options: {
      ...variant.options,
      [providerConnection.protocol === "openai" ? "max_output_tokens" : "max_tokens"]: alias.limits.maxOutputTokens,
    },
  }
}

export const resolveModelRoute: {
  (mode: ModeId, role?: Role): (settings: Settings) => ResolvedModelRoute
  (settings: Settings, mode: ModeId, role?: Role): ResolvedModelRoute
} = Function.dual(
  (args) => typeof args[0] === "object",
  (settings: Settings, mode: ModeId, role: Role = "main") =>
    resolveRoute(settings, settings.modes[mode][role], `Mode ${mode} ${role}`),
)

export const resolveThreadTitleRoute = (settings: Settings): ResolvedModelRoute =>
  resolveRoute(settings, { ...settings.modes.low.main, effort: "low", fast: false }, "Thread title model")

export const resolveAgentRoute: {
  (agent: AgentId): (settings: Settings) => ResolvedModelRoute
  (settings: Settings, agent: AgentId): ResolvedModelRoute
} = Function.dual(2, (settings: Settings, agent: AgentId) =>
  resolveRoute(settings, settings.agents[agent], `Agent ${agent}`),
)

export const resolveCompactionSummaryRoute = (settings: Settings): ResolvedModelRoute =>
  resolveRoute(settings, settings.compaction.summaryModel, "Compaction summary model")

export const decodeSettingsInput: {
  (value: unknown): (path: string) => SettingsInput
  (path: string, value: unknown): SettingsInput
} = Function.dual(2, (path: string, value: unknown): SettingsInput => {
  if (!object(value)) throw ConfigFileError.make({ path, message: "Configuration must be a JSON object" })
  exactKeys(path, "Configuration", value, [
    "providers",
    "keymap",
    "permissions",
    "extensionRoots",
    "mcp",
    "notifications",
    "logging",
  ])
  if (value.providers !== undefined && !object(value.providers))
    throw ConfigFileError.make({ path, message: "Providers must be an object" })
  exactKeys(path, "Providers", (value.providers ?? {}) as Record<string, unknown>, ["openai", "anthropic"])
  for (const [name, providerConnection] of Object.entries((value.providers ?? {}) as Record<string, unknown>)) {
    if (!object(providerConnection)) throw ConfigFileError.make({ path, message: `Provider ${name} must be an object` })
    exactKeys(path, `Provider ${name}`, providerConnection, ["baseUrl", "apiKeyEnv"])
    if (
      providerConnection.apiKeyEnv !== undefined &&
      (typeof providerConnection.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(providerConnection.apiKeyEnv))
    )
      throw ConfigFileError.make({
        path,
        message: `Provider ${name} apiKeyEnv must be an uppercase environment variable`,
      })
    if (providerConnection.baseUrl !== undefined && typeof providerConnection.baseUrl !== "string")
      throw ConfigFileError.make({ path, message: `Provider ${name} baseUrl must be a string` })
    if (providerConnection.baseUrl === undefined) continue
    let providerUrl: URL
    try {
      providerUrl = new URL(providerConnection.baseUrl)
    } catch {
      throw ConfigFileError.make({ path, message: `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL` })
    }
    if ((providerUrl.protocol !== "http:" && providerUrl.protocol !== "https:") || providerUrl.hostname.length === 0)
      throw ConfigFileError.make({ path, message: `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL` })
    if (
      providerUrl.username.length > 0 ||
      providerUrl.password.length > 0 ||
      providerUrl.search.length > 0 ||
      providerUrl.hash.length > 0
    )
      throw ConfigFileError.make({ path, message: `Provider ${name} baseUrl cannot contain credentials` })
  }
  if (value.logging !== undefined) {
    if (!object(value.logging)) throw ConfigFileError.make({ path, message: "Logging must be an object" })
    exactKeys(path, "Logging", value.logging, ["level"])
    if (
      value.logging.level !== undefined &&
      value.logging.level !== "debug" &&
      value.logging.level !== "info" &&
      value.logging.level !== "warning" &&
      value.logging.level !== "error"
    )
      throw ConfigFileError.make({ path, message: "Logging level must be debug, info, warning, or error" })
  }
  return value as SettingsInput
})

export const defaults: Settings = {
  providers: {
    openai: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    anthropic: {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
  },
  models: modelDefaults,
  modes: {
    low: { main: { alias: "luna", effort: "low" }, oracle: { alias: "sol", effort: "high" } },
    medium: { main: { alias: "terra", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
    high: { main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "sol", effort: "max" } },
    ultra: { main: { alias: "sol", effort: "max" }, oracle: { alias: "sol", effort: "max" } },
  },
  agents: {
    librarian: { alias: "sol", effort: "high" },
    painter: { alias: "sol", effort: "high" },
    review: { alias: "sol", effort: "high" },
    readThread: { alias: "terra", effort: "medium" },
    task: { alias: "terra", effort: "medium" },
  },
  compaction: { summaryModel: { alias: "terra", effort: "medium" } },
  keymap: { mode: "ctrl+s", palette: "ctrl+p", submit: "enter", newline: "shift+enter", interrupt: "escape" },
  permissions: { read: "allow", search: "allow", write: "allow", shell: "allow", external: "allow" },
  extensionRoots: ["~/.config/rika/extensions", ".rika/extensions"],
  mcp: {},
  notifications: { enabled: true },
  logging: { level: "info" },
}
