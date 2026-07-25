import { Function, Schema, type Redacted } from "effect"
import { defaults as modelDefaults, presetIds, presets, supportedEfforts } from "./models"

export type ModeId = "low" | "medium" | "high" | "ultra"
export type Role = "main" | "oracle"
export type AgentId = "librarian" | "painter" | "review" | "readThread" | "surgeon" | "task"
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
  bedrock: {
    protocol: "amazon-bedrock",
    authMode: "default",
  },
} as const

export type ProviderId = keyof typeof providerDefaults
export interface HttpProviderConnection {
  readonly protocol: "openai" | "anthropic"
  readonly baseUrl: string
  readonly apiKeyEnv?: string | undefined
  readonly streamingOnly?: boolean | undefined
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
  readonly streamingOnly?: boolean
}
export type ProviderOverride = HttpProviderOverride | Omit<AmazonBedrockProviderConnection, "protocol">

export interface ModelAliasInput {
  readonly base?: string
  readonly preset?: string
  readonly provider: ProviderId
  readonly candidates: ReadonlyArray<string>
  readonly displayName?: string
  readonly supportsMedia?: boolean
  readonly limits?: {
    readonly maxInputTokens: number
    readonly maxOutputTokens: number
    readonly keepRecentTokens: number
  }
  readonly efforts?: Readonly<Record<string, { readonly normal: ModelVariant; readonly fast?: ModelVariant }>>
}
export interface RoleRouteInput {
  readonly alias: string
  readonly effort?: Effort
  readonly fast?: boolean
}
export interface ModelRoutesInput {
  readonly modes?: Partial<Readonly<Record<ModeId, Partial<Readonly<Record<Role, string | RoleRouteInput>>>>>>
  readonly title?: string | RoleRouteInput
  readonly agents?: Partial<Readonly<Record<AgentId, string | RoleRouteInput>>>
  readonly compaction?: string | RoleRouteInput
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
  readonly displayName: string
  readonly supportsMedia: boolean
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
  readonly threadTitle: RoleRoute
  readonly agents: Partial<Readonly<Record<AgentId, RoleRouteInput>>>
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
  readonly modelAliases?: Readonly<Record<string, ModelAliasInput>>
  readonly modelRoutes?: ModelRoutesInput
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
  readonly displayName: string
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
    displayName: alias.displayName,
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

export const agentIds = ["librarian", "painter", "review", "readThread", "surgeon", "task"] as const

const resolveAgentRouteImpl = (
  settings: Settings,
  mode: ModeId,
  agent: AgentId,
  tuning?: { readonly fastMode?: boolean },
): ResolvedModelRoute => {
  const role = agent === "task" || agent === "surgeon" ? "main" : "oracle"
  const inherited = settings.modes[mode][role]
  const configured = settings.agents[agent]
  const fast = tuning?.fastMode ?? configured?.fast ?? inherited.fast ?? false
  if (configured === undefined) return resolveRoute(settings, { ...inherited, fast }, `Agent ${agent}`)
  return resolveRoute(
    settings,
    { alias: configured.alias, effort: configured.effort ?? inherited.effort, fast },
    `Agent ${agent}`,
  )
}

export const resolveAgentRoute: {
  (mode: ModeId, agent: AgentId, tuning?: { readonly fastMode?: boolean }): (settings: Settings) => ResolvedModelRoute
  (settings: Settings, mode: ModeId, agent: AgentId, tuning?: { readonly fastMode?: boolean }): ResolvedModelRoute
} = Function.dual((args) => typeof args[0] === "object", resolveAgentRouteImpl)

export interface ModeRouteLabel {
  readonly name: string
  readonly effort: string
  readonly fast: boolean
}

const routeLabel = (settings: Settings, mode: ModeId, role: Role): ModeRouteLabel => {
  const configured = settings.modes[mode][role]
  try {
    const route = resolveRoute(settings, configured, `Mode ${mode} ${role}`)
    return { name: route.displayName, effort: route.effort, fast: route.fast }
  } catch {
    return {
      name: settings.models[configured.alias]?.displayName ?? configured.alias,
      effort: configured.effort,
      fast: configured.fast === true,
    }
  }
}

export const modeRouteLabels = (
  settings: Settings,
): Readonly<Record<ModeId, { readonly main: ModeRouteLabel; readonly oracle: ModeRouteLabel }>> =>
  Object.fromEntries(
    (Object.keys(settings.modes) as ReadonlyArray<ModeId>).map((mode) => [
      mode,
      { main: routeLabel(settings, mode, "main"), oracle: routeLabel(settings, mode, "oracle") },
    ]),
  ) as Readonly<Record<ModeId, { readonly main: ModeRouteLabel; readonly oracle: ModeRouteLabel }>>

export const resolveThreadTitleRoute = (settings: Settings): ResolvedModelRoute =>
  resolveRoute(settings, settings.threadTitle, "Thread title model")

export const resolveCompactionSummaryRoute = (settings: Settings): ResolvedModelRoute =>
  resolveRoute(settings, settings.compaction.summaryModel, "Compaction summary model")

export const decodeSettingsInput: {
  (value: unknown): (path: string) => SettingsInput
  (path: string, value: unknown): SettingsInput
} = Function.dual(2, (path: string, value: unknown): SettingsInput => {
  if (!object(value)) throw ConfigFileError.make({ path, message: "Configuration must be a JSON object" })
  exactKeys(path, "Configuration", value, [
    "providers",
    "modelAliases",
    "modelRoutes",
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
    if (name === "bedrock") {
      exactKeys(path, `Provider ${name}`, providerConnection, [
        "region",
        "profile",
        "endpoint",
        "authMode",
        "authRefresh",
      ])
      for (const field of ["region", "profile"] as const)
        if (
          providerConnection[field] !== undefined &&
          (typeof providerConnection[field] !== "string" || providerConnection[field].length === 0)
        )
          throw ConfigFileError.make({ path, message: `Provider ${name} ${field} must be a non-empty string` })
      if (
        providerConnection.authMode !== undefined &&
        providerConnection.authMode !== "default" &&
        providerConnection.authMode !== "bearer"
      )
        throw ConfigFileError.make({ path, message: `Provider ${name} authMode must be default or bearer` })
      if (providerConnection.endpoint !== undefined) {
        httpUrl(path, `Provider ${name} endpoint`, providerConnection.endpoint)
        const endpoint = new URL(providerConnection.endpoint as string)
        if (endpoint.search.length > 0 || endpoint.hash.length > 0)
          throw ConfigFileError.make({ path, message: `Provider ${name} endpoint cannot contain query or fragment` })
        if (
          endpoint.protocol !== "https:" &&
          endpoint.hostname !== "localhost" &&
          endpoint.hostname !== "127.0.0.1" &&
          endpoint.hostname !== "[::1]"
        )
          throw ConfigFileError.make({ path, message: `Provider ${name} endpoint must use HTTPS except on loopback` })
      }
      if (providerConnection.authRefresh !== undefined) {
        if (providerConnection.authMode === "bearer")
          throw ConfigFileError.make({
            path,
            message: `Provider ${name} authRefresh is unavailable in bearer auth mode`,
          })
        if (!object(providerConnection.authRefresh))
          throw ConfigFileError.make({ path, message: `Provider ${name} authRefresh must be an object` })
        exactKeys(path, `Provider ${name} authRefresh`, providerConnection.authRefresh, ["command", "args"])
        if (
          typeof providerConnection.authRefresh.command !== "string" ||
          providerConnection.authRefresh.command.length === 0
        )
          throw ConfigFileError.make({
            path,
            message: `Provider ${name} authRefresh command must be a non-empty string`,
          })
        if (
          !Array.isArray(providerConnection.authRefresh.args) ||
          providerConnection.authRefresh.args.some((arg) => typeof arg !== "string")
        )
          throw ConfigFileError.make({ path, message: `Provider ${name} authRefresh args must be an array of strings` })
      }
      continue
    }
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
  if (value.modelAliases !== undefined) {
    if (!object(value.modelAliases)) throw ConfigFileError.make({ path, message: "Model aliases must be an object" })
    for (const [name, alias] of Object.entries(value.modelAliases)) {
      if (name.length === 0 || !object(alias))
        throw ConfigFileError.make({ path, message: "Model alias names must be non-empty" })
      if (name in modelDefaults)
        throw ConfigFileError.make({ path, message: `Model alias ${name} cannot replace a built-in model alias` })
      exactKeys(path, `Model alias ${name}`, alias, [
        "base",
        "preset",
        "provider",
        "candidates",
        "displayName",
        "supportsMedia",
        "limits",
        "efforts",
      ])
      if (alias.supportsMedia !== undefined && typeof alias.supportsMedia !== "boolean")
        throw ConfigFileError.make({ path, message: `Model alias ${name} supportsMedia must be true or false` })
      if (typeof alias.provider !== "string" || !(alias.provider in providerDefaults))
        throw ConfigFileError.make({ path, message: `Model alias ${name} provider is unknown` })
      if (
        !Array.isArray(alias.candidates) ||
        alias.candidates.length === 0 ||
        alias.candidates.some((candidate) => typeof candidate !== "string" || candidate.length === 0)
      )
        throw ConfigFileError.make({ path, message: `Model alias ${name} candidates must be non-empty strings` })
      if (alias.base !== undefined && (typeof alias.base !== "string" || !(alias.base in modelDefaults)))
        throw ConfigFileError.make({ path, message: `Model alias ${name} base must reference a built-in model alias` })
      if (
        alias.preset !== undefined &&
        (typeof alias.preset !== "string" || !presetIds.includes(alias.preset as never))
      )
        throw ConfigFileError.make({
          path,
          message: `Model alias ${name} preset must be one of ${presetIds.join(", ")}`,
        })
      const sources = [alias.base, alias.preset, alias.efforts].filter((value) => value !== undefined).length
      if (sources === 0)
        throw ConfigFileError.make({
          path,
          message: `Model alias ${name} must set preset or efforts. Presets: ${presetIds.join(", ")}`,
        })
      if (sources > 1)
        throw ConfigFileError.make({
          path,
          message: `Model alias ${name} must set only one of base, preset, or efforts`,
        })
      if (alias.displayName !== undefined && (typeof alias.displayName !== "string" || alias.displayName.length === 0))
        throw ConfigFileError.make({ path, message: `Model alias ${name} displayName must be a non-empty string` })
      if (alias.efforts !== undefined && alias.limits === undefined)
        throw ConfigFileError.make({ path, message: `Model alias ${name} must set limits when it sets efforts` })
      if (alias.limits !== undefined) {
        if (!object(alias.limits))
          throw ConfigFileError.make({ path, message: `Model alias ${name} limits must be an object` })
        exactKeys(path, `Model alias ${name} limits`, alias.limits, [
          "maxInputTokens",
          "maxOutputTokens",
          "keepRecentTokens",
        ])
        for (const key of ["maxInputTokens", "maxOutputTokens", "keepRecentTokens"]) {
          const limit = alias.limits[key]
          if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)
            throw ConfigFileError.make({ path, message: `Model alias ${name} limits ${key} must be a positive number` })
        }
      }
      if (alias.efforts !== undefined) {
        if (!object(alias.efforts))
          throw ConfigFileError.make({ path, message: `Model alias ${name} efforts must be an object` })
        const protocol = providerDefaults[alias.provider as ProviderId].protocol
        const allowed = presetIds.flatMap((id) =>
          presets[id].protocols.includes(protocol) ? presets[id].optionKeys : [],
        )
        for (const [effort, variants] of Object.entries(alias.efforts)) {
          if (!supportedEfforts.includes(effort as never))
            throw ConfigFileError.make({
              path,
              message: `Model alias ${name} effort ${effort} must be one of ${supportedEfforts.join(", ")}`,
            })
          if (!object(variants))
            throw ConfigFileError.make({ path, message: `Model alias ${name} effort ${effort} must be an object` })
          exactKeys(path, `Model alias ${name} effort ${effort}`, variants, ["normal", "fast"])
          for (const [speed, variant] of Object.entries(variants)) {
            if (!object(variant) || !object((variant as Record<string, unknown>).options))
              throw ConfigFileError.make({
                path,
                message: `Model alias ${name} effort ${effort} ${speed} must set options`,
              })
            const options = (variant as { options: Record<string, unknown> }).options
            const rejected = Object.keys(options).find((key) => !allowed.includes(key))
            if (rejected !== undefined)
              throw ConfigFileError.make({
                path,
                message: `Model alias ${name} effort ${effort} sets ${rejected}, which provider ${alias.provider} (${protocol}) does not accept. Accepted: ${allowed.join(", ")}`,
              })
          }
        }
      }
    }
  }
  if (value.modelRoutes !== undefined) {
    if (!object(value.modelRoutes)) throw ConfigFileError.make({ path, message: "Model routes must be an object" })
    exactKeys(path, "Model routes", value.modelRoutes, ["modes", "title", "agents", "compaction"])
    const roleRoute = (owner: string, route: unknown) => {
      if (typeof route === "string") {
        if (route.length === 0) throw ConfigFileError.make({ path, message: `${owner} alias must be non-empty` })
        return
      }
      if (!object(route)) throw ConfigFileError.make({ path, message: `${owner} must be an alias or an object` })
      exactKeys(path, owner, route, ["alias", "effort", "fast"])
      if (typeof route.alias !== "string" || route.alias.length === 0)
        throw ConfigFileError.make({ path, message: `${owner} alias must be non-empty` })
      if (route.effort !== undefined && !supportedEfforts.includes(route.effort as never))
        throw ConfigFileError.make({
          path,
          message: `${owner} effort must be one of ${supportedEfforts.join(", ")}`,
        })
      if (route.fast !== undefined && typeof route.fast !== "boolean")
        throw ConfigFileError.make({ path, message: `${owner} fast must be true or false` })
    }
    if (value.modelRoutes.modes !== undefined) {
      if (!object(value.modelRoutes.modes))
        throw ConfigFileError.make({ path, message: "Model route modes must be an object" })
      exactKeys(path, "Model route modes", value.modelRoutes.modes, ["low", "medium", "high", "ultra"])
      for (const [mode, roles] of Object.entries(value.modelRoutes.modes)) {
        if (!object(roles)) throw ConfigFileError.make({ path, message: `Model route mode ${mode} must be an object` })
        exactKeys(path, `Model route mode ${mode}`, roles, ["main", "oracle"])
        for (const [role, route] of Object.entries(roles)) roleRoute(`Model route mode ${mode} ${role}`, route)
      }
    }
    if (value.modelRoutes.title !== undefined) roleRoute("Model route title", value.modelRoutes.title)
    if (value.modelRoutes.agents !== undefined) {
      if (!object(value.modelRoutes.agents))
        throw ConfigFileError.make({ path, message: "Model route agents must be an object" })
      exactKeys(path, "Model route agents", value.modelRoutes.agents, [
        "librarian",
        "painter",
        "review",
        "readThread",
        "surgeon",
        "task",
      ])
      for (const [agent, route] of Object.entries(value.modelRoutes.agents))
        roleRoute(`Model route agent ${agent}`, route)
    }
    if (value.modelRoutes.compaction !== undefined) roleRoute("Model route compaction", value.modelRoutes.compaction)
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
    low: { main: { alias: "luna", effort: "xhigh" }, oracle: { alias: "terra", effort: "xhigh" } },
    medium: { main: { alias: "terra", effort: "xhigh" }, oracle: { alias: "sol", effort: "medium" } },
    high: { main: { alias: "sol", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
    ultra: { main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "sol", effort: "max" } },
  },
  threadTitle: { alias: "luna", effort: "low" },
  agents: {},
  compaction: { summaryModel: { alias: "sol", effort: "xhigh" } },
  keymap: { mode: "ctrl+s", palette: "ctrl+p", submit: "enter", newline: "shift+enter", interrupt: "escape" },
  permissions: { read: "allow", search: "allow", write: "allow", shell: "allow", external: "allow" },
  extensionRoots: ["~/.config/rika/extensions", ".rika/extensions"],
  mcp: {},
  notifications: { enabled: true },
  logging: { level: "info" },
  webSearch: { providers: {} },
}
