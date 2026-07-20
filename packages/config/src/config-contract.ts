import { Function, Schema, type Redacted } from "effect"
import { defaults as modelDefaults } from "./models"

export type ModeId = "low" | "medium" | "high" | "ultra"
export type Role = "main" | "oracle"
export type AgentId = "librarian" | "painter" | "review" | "readThread" | "task"
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type PermissionDecision = "allow" | "ask" | "deny"
export type LogLevel = "debug" | "info" | "warning" | "error"

export const providerDefaults = {
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
} as const

export type ProviderId = keyof typeof providerDefaults
export interface ProviderConnection {
  readonly protocol: string
  readonly baseUrl: string
  readonly apiKeyEnv?: string | undefined
  readonly streamingOnly?: boolean | undefined
}
export interface ProviderOverride {
  readonly baseUrl?: string
  readonly apiKeyEnv?: string
  readonly streamingOnly?: boolean
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
  readonly webSearch: {
    readonly providers: Readonly<Record<string, { readonly configured: true }>>
  }
}

export interface SettingsInput {
  readonly providers?: Partial<Readonly<Record<ProviderId, ProviderOverride>>>
  readonly keymap?: Readonly<Record<string, string>>
  readonly permissions?: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots?: ReadonlyArray<string>
  readonly mcp?: Readonly<Record<string, McpDefinition>>
  readonly notifications?: Partial<Settings["notifications"]>
  readonly logging?: Partial<Settings["logging"]>
  readonly webSearch?: {
    readonly providers: Readonly<Record<string, { readonly apiKey: string }>>
  }
}

export interface Environment {
  readonly providerCredentials: Readonly<Record<string, Redacted.Redacted>>
  readonly webSearchCredentials: Readonly<Record<string, Redacted.Redacted>>
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
  readonly maxOutputTokens: number
  readonly options: Readonly<Record<string, unknown>>
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const exactKeys = (path: string, label: string, value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw ConfigFileError.make({ path, message: `${label} contains unknown key ${unknown}` })
}

const stringMap = (path: string, label: string, value: unknown): Record<string, string> => {
  if (!object(value)) throw ConfigFileError.make({ path, message: `${label} must be an object` })
  if (Object.values(value).some((entry) => typeof entry !== "string"))
    throw ConfigFileError.make({ path, message: `${label} values must be strings` })
  return value as Record<string, string>
}

const httpUrl = (path: string, label: string, value: unknown) => {
  if (typeof value !== "string") throw ConfigFileError.make({ path, message: `${label} must be a string` })
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw ConfigFileError.make({ path, message: `${label} must be an absolute HTTP or HTTPS URL` })
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0)
    throw ConfigFileError.make({ path, message: `${label} must be an absolute HTTP or HTTPS URL` })
  if (url.username.length > 0 || url.password.length > 0)
    throw ConfigFileError.make({ path, message: `${label} cannot contain credentials` })
}

const resolveRoute = (settings: Settings, route: RoleRoute, owner: string): ResolvedModelRoute => {
  const alias = settings.models[route.alias]
  if (alias === undefined)
    throw ModelRouteError.make({ mode: owner, message: `${owner} references missing model alias ${route.alias}` })
  const providerConnection = settings.providers[alias.provider]
  if (providerConnection === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} model alias ${route.alias} references missing provider ${alias.provider}`,
    })
  const model = alias.candidates[0]
  if (model === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `${owner} model alias ${route.alias} has no provider candidates`,
    })
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
    model,
    compaction: {
      contextWindow: alias.limits.maxInputTokens + alias.limits.maxOutputTokens,
      reserveTokens: alias.limits.maxOutputTokens,
      keepRecentTokens: alias.limits.keepRecentTokens,
    },
    maxOutputTokens: alias.limits.maxOutputTokens,
    options: variant.options,
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
    "webSearch",
  ])
  if (value.providers !== undefined && !object(value.providers))
    throw ConfigFileError.make({ path, message: "Providers must be an object" })
  exactKeys(path, "Providers", (value.providers ?? {}) as Record<string, unknown>, Object.keys(providerDefaults))
  for (const [name, providerConnection] of Object.entries((value.providers ?? {}) as Record<string, unknown>)) {
    if (!object(providerConnection)) throw ConfigFileError.make({ path, message: `Provider ${name} must be an object` })
    exactKeys(path, `Provider ${name}`, providerConnection, ["baseUrl", "apiKeyEnv", "streamingOnly"])
    if (providerConnection.streamingOnly !== undefined && typeof providerConnection.streamingOnly !== "boolean")
      throw ConfigFileError.make({ path, message: `Provider ${name} streamingOnly must be a boolean` })
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
    if (!/^https?:\/\/[^\s\\]+$/i.test(providerConnection.baseUrl))
      throw ConfigFileError.make({ path, message: `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL` })
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
  if (value.keymap !== undefined) stringMap(path, "Keymap", value.keymap)
  if (value.permissions !== undefined) {
    const permissions = stringMap(path, "Permissions", value.permissions)
    if (
      Object.values(permissions).some((decision) => decision !== "allow" && decision !== "ask" && decision !== "deny")
    )
      throw ConfigFileError.make({ path, message: "Permission values must be allow, ask, or deny" })
  }
  if (
    value.extensionRoots !== undefined &&
    (!Array.isArray(value.extensionRoots) || value.extensionRoots.some((root) => typeof root !== "string"))
  )
    throw ConfigFileError.make({ path, message: "Extension roots must be an array of strings" })
  if (value.mcp !== undefined) {
    if (!object(value.mcp)) throw ConfigFileError.make({ path, message: "MCP must be an object" })
    for (const [name, definition] of Object.entries(value.mcp)) {
      if (!object(definition)) throw ConfigFileError.make({ path, message: `MCP ${name} must be an object` })
      if (definition.transport === "command") {
        exactKeys(path, `MCP ${name}`, definition, ["transport", "command", "args", "cwd", "environment", "enabled"])
        if (typeof definition.command !== "string" || definition.command.length === 0)
          throw ConfigFileError.make({ path, message: `MCP ${name} command must be a non-empty string` })
        if (!Array.isArray(definition.args) || definition.args.some((argument) => typeof argument !== "string"))
          throw ConfigFileError.make({ path, message: `MCP ${name} args must be an array of strings` })
        if (definition.cwd !== undefined && typeof definition.cwd !== "string")
          throw ConfigFileError.make({ path, message: `MCP ${name} cwd must be a string` })
        stringMap(path, `MCP ${name} environment`, definition.environment)
      } else if (definition.transport === "remote") {
        exactKeys(path, `MCP ${name}`, definition, ["transport", "url", "headers", "enabled"])
        httpUrl(path, `MCP ${name} url`, definition.url)
        stringMap(path, `MCP ${name} headers`, definition.headers)
      } else {
        throw ConfigFileError.make({ path, message: `MCP ${name} transport must be command or remote` })
      }
      if (typeof definition.enabled !== "boolean")
        throw ConfigFileError.make({ path, message: `MCP ${name} enabled must be a boolean` })
    }
  }
  if (value.notifications !== undefined) {
    if (!object(value.notifications)) throw ConfigFileError.make({ path, message: "Notifications must be an object" })
    exactKeys(path, "Notifications", value.notifications, ["enabled", "command"])
    if (value.notifications.enabled !== undefined && typeof value.notifications.enabled !== "boolean")
      throw ConfigFileError.make({ path, message: "Notifications enabled must be a boolean" })
    if (value.notifications.command !== undefined && typeof value.notifications.command !== "string")
      throw ConfigFileError.make({ path, message: "Notifications command must be a string" })
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
  if (value.webSearch !== undefined) {
    if (!object(value.webSearch)) throw ConfigFileError.make({ path, message: "Web search must be an object" })
    exactKeys(path, "Web search", value.webSearch, ["providers"])
    if (!object(value.webSearch.providers))
      throw ConfigFileError.make({ path, message: "Web search providers must be an object" })
    for (const [id, provider] of Object.entries(value.webSearch.providers)) {
      if (id.length === 0)
        throw ConfigFileError.make({ path, message: "Web search provider ID must be a non-empty string" })
      if (!object(provider))
        throw ConfigFileError.make({ path, message: `Web search provider ${id} must be an object` })
      exactKeys(path, `Web search provider ${id}`, provider, ["apiKey"])
      if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0)
        throw ConfigFileError.make({ path, message: `Web search provider ${id} apiKey must be a non-empty string` })
    }
  }
  return value as SettingsInput
})

export const defaults: Settings = {
  providers: providerDefaults,
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
  webSearch: { providers: {} },
}
