import { Function, Schema, type Redacted } from "effect"
import { defaults as modelDefaults, supportedEfforts } from "./models"

export type ModeId = "low" | "medium" | "high" | "ultra"
export type Role = "main" | "oracle"
export type AgentId = "librarian" | "painter" | "review" | "readThread" | "task"
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type PermissionDecision = "allow" | "ask" | "deny"
export type LogLevel = "debug" | "info" | "warning" | "error"

export type GatewayAuth = { readonly type: "none" } | { readonly type: "bearer-env"; readonly variable: string }
export type GatewayConnection =
  | { readonly protocol: "openai"; readonly baseUrl: string; readonly auth: GatewayAuth }
  | { readonly protocol: "anthropic"; readonly baseUrl: string; readonly auth: GatewayAuth }

export interface ModelVariant {
  readonly options: Readonly<Record<string, unknown>>
}

export interface ModelAlias {
  readonly gateway: string
  readonly candidates: ReadonlyArray<string>
  readonly limits: {
    readonly maxInputTokens: number
    readonly maxOutputTokens: number
    readonly keepRecentTokens: number
  }
  readonly variants: Partial<Readonly<Record<Effort, { readonly normal: ModelVariant; readonly fast?: ModelVariant }>>>
}

export interface ModelAliasInput {
  readonly gateway?: string
  readonly candidates?: ReadonlyArray<string>
  readonly limits?: Partial<ModelAlias["limits"]>
  readonly variants?: ModelAlias["variants"]
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
  readonly gateways: Readonly<Record<string, GatewayConnection>>
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
  readonly gateways?: Readonly<Record<string, GatewayConnection>>
  readonly models?: Readonly<Record<string, ModelAliasInput>>
  readonly modes?: Partial<Readonly<Record<ModeId, ModeConfig>>>
  readonly agents?: Partial<Readonly<Record<AgentId, RoleRoute>>>
  readonly compaction?: Partial<Settings["compaction"]>
  readonly keymap?: Readonly<Record<string, string>>
  readonly permissions?: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots?: ReadonlyArray<string>
  readonly mcp?: Readonly<Record<string, McpDefinition>>
  readonly notifications?: Partial<Settings["notifications"]>
  readonly logging?: Partial<Settings["logging"]>
}

export interface Environment {
  readonly gatewayCredentials: Readonly<Record<string, Redacted.Redacted>>
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
  readonly gatewayName: string
  readonly gateway: GatewayConnection
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

const positiveInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const efforts: ReadonlyArray<Effort> = supportedEfforts
const allowedModelOptionKeys = new Set(["maxtokens", "maxoutputtokens", "reasoning", "servicetier"])
const credentialTerms = new Set([
  "auth",
  "authorization",
  "authentication",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "bearer",
  "signature",
  "sig",
])

const keyParts = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0)

const credentialLikeKey = (key: string) => {
  const parts = keyParts(key)
  const normalized = parts.join("")
  if (allowedModelOptionKeys.has(normalized)) return false
  if (parts.some((part) => credentialTerms.has(part))) return true
  if (parts.includes("token")) return true
  return [
    "apikey",
    "accesstoken",
    "authtoken",
    "clientsecret",
    "privatekey",
    "secretkey",
    "sessiontoken",
    "refreshtoken",
    "idtoken",
  ].some((term) => normalized.includes(term))
}

const credentialOptionPath = (value: unknown, path: string): string | undefined => {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = credentialOptionPath(item, `${path}.${index}`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!object(value)) return undefined
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}.${key}`
    if (credentialLikeKey(key)) return nextPath
    const found = credentialOptionPath(item, nextPath)
    if (found !== undefined) return found
  }
  return undefined
}

const resolveRoute = (settings: Settings, route: RoleRoute, owner: string): ResolvedModelRoute => {
  const alias = settings.models[route.alias]
  if (alias === undefined)
    throw ModelRouteError.make({ mode: owner, message: `${owner} references missing model alias ${route.alias}` })
  const gateway = settings.gateways[alias.gateway]
  if (gateway === undefined)
    throw ModelRouteError.make({
      mode: owner,
      message: `Model alias ${route.alias} references missing gateway ${alias.gateway}`,
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
    gatewayName: alias.gateway,
    gateway,
    candidates: alias.candidates,
    model: alias.candidates[0]!,
    compaction: {
      contextWindow: alias.limits.maxInputTokens + alias.limits.maxOutputTokens,
      reserveTokens: alias.limits.maxOutputTokens,
      keepRecentTokens: alias.limits.keepRecentTokens,
    },
    options: {
      ...variant.options,
      [gateway.protocol === "openai" ? "max_output_tokens" : "max_tokens"]: alias.limits.maxOutputTokens,
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
    "gateways",
    "models",
    "modes",
    "agents",
    "compaction",
    "keymap",
    "permissions",
    "extensionRoots",
    "mcp",
    "notifications",
    "logging",
  ])
  for (const [name, gateway] of Object.entries((value.gateways ?? {}) as Record<string, unknown>)) {
    if (!object(gateway)) throw ConfigFileError.make({ path, message: `Gateway ${name} must be an object` })
    if (gateway.protocol !== "openai" && gateway.protocol !== "anthropic")
      throw ConfigFileError.make({ path, message: `Gateway ${name} requires an explicit supported protocol` })
    exactKeys(path, `Gateway ${name}`, gateway, ["protocol", "baseUrl", "auth"])
    if (!object(gateway.auth) || (gateway.auth.type !== "none" && gateway.auth.type !== "bearer-env"))
      throw ConfigFileError.make({ path, message: `Gateway ${name} auth must be none or bearer-env` })
    exactKeys(path, `Gateway ${name} auth`, gateway.auth, ["type", "variable"])
    if (
      gateway.auth.type === "bearer-env" &&
      (typeof gateway.auth.variable !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(gateway.auth.variable))
    )
      throw ConfigFileError.make({ path, message: `Gateway ${name} bearer-env auth requires an environment variable` })
    if (gateway.auth.type === "none" && gateway.auth.variable !== undefined)
      throw ConfigFileError.make({ path, message: `Gateway ${name} none auth cannot name an environment variable` })
    if (typeof gateway.baseUrl !== "string")
      throw ConfigFileError.make({ path, message: `Gateway ${name} baseUrl must be a string` })
    let gatewayUrl: URL
    try {
      gatewayUrl = new URL(gateway.baseUrl)
    } catch {
      throw ConfigFileError.make({ path, message: `Gateway ${name} baseUrl must be an absolute HTTP or HTTPS URL` })
    }
    if ((gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:") || gatewayUrl.hostname.length === 0)
      throw ConfigFileError.make({ path, message: `Gateway ${name} baseUrl must be an absolute HTTP or HTTPS URL` })
    if (
      gatewayUrl.username.length > 0 ||
      gatewayUrl.password.length > 0 ||
      Array.from(gatewayUrl.searchParams.keys()).some(credentialLikeKey)
    )
      throw ConfigFileError.make({ path, message: `Gateway ${name} baseUrl cannot contain credentials` })
  }
  for (const [name, model] of Object.entries((value.models ?? {}) as Record<string, unknown>)) {
    if (!object(model)) throw ConfigFileError.make({ path, message: `Model alias ${name} must be an object` })
    exactKeys(path, `Model alias ${name}`, model, ["gateway", "candidates", "limits", "variants"])
    const builtIn = (modelDefaults as Readonly<Record<string, ModelAlias>>)[name]
    const resolved = {
      ...builtIn,
      ...model,
      limits: { ...builtIn?.limits, ...(object(model.limits) ? model.limits : {}) },
      variants: { ...builtIn?.variants, ...(object(model.variants) ? model.variants : {}) },
    }
    if (
      typeof resolved.gateway !== "string" ||
      !Array.isArray(resolved.candidates) ||
      resolved.candidates.length === 0 ||
      resolved.candidates.some((id: unknown) => typeof id !== "string")
    )
      throw ConfigFileError.make({
        path,
        message: `Model alias ${name} requires gateway and non-empty string candidates`,
      })
    if (!object(resolved.limits))
      throw ConfigFileError.make({ path, message: `Model alias ${name} requires valid model limits` })
    const { maxInputTokens, maxOutputTokens, keepRecentTokens } = resolved.limits
    if (
      !positiveInteger(maxInputTokens) ||
      !positiveInteger(maxOutputTokens) ||
      !positiveInteger(keepRecentTokens) ||
      (keepRecentTokens as number) >= (maxInputTokens as number) ||
      (maxInputTokens as number) + (maxOutputTokens as number) > Number.MAX_SAFE_INTEGER
    )
      throw ConfigFileError.make({ path, message: `Model alias ${name} requires valid model limits` })
    if (model.limits !== undefined) {
      if (!object(model.limits))
        throw ConfigFileError.make({ path, message: `Model alias ${name} requires valid model limits` })
      exactKeys(path, `Model alias ${name} limits`, model.limits, [
        "maxInputTokens",
        "maxOutputTokens",
        "keepRecentTokens",
      ])
    }
    if (!object(resolved.variants) || Object.keys(resolved.variants).length === 0)
      throw ConfigFileError.make({ path, message: `Model alias ${name} requires variants` })
    for (const [effort, variants] of Object.entries(resolved.variants)) {
      if (!efforts.includes(effort as Effort) || !object(variants) || !object(variants.normal))
        throw ConfigFileError.make({ path, message: `Model alias ${name} has invalid effort variant ${effort}` })
      exactKeys(path, `Model alias ${name} ${effort}`, variants, ["normal", "fast"])
      for (const variant of [variants.normal, variants.fast].filter((item) => item !== undefined)) {
        if (!object(variant) || !object(variant.options))
          throw ConfigFileError.make({ path, message: `Model alias ${name} ${effort} variant requires options` })
        exactKeys(path, `Model alias ${name} ${effort} variant`, variant, ["options"])
        if ("max_tokens" in variant.options || "max_output_tokens" in variant.options)
          throw ConfigFileError.make({
            path,
            message: `Model alias ${name} ${effort} provider output limit must use limits.maxOutputTokens`,
          })
        const credentialPath = credentialOptionPath(variant.options, `models.${name}.variants.${effort}.options`)
        if (credentialPath !== undefined)
          throw ConfigFileError.make({
            path,
            message: `Model alias ${name} ${effort} variant contains credential-like provider option key at ${credentialPath}`,
          })
      }
    }
  }
  for (const [mode, config] of Object.entries((value.modes ?? {}) as Record<string, unknown>)) {
    if (!object(config)) throw ConfigFileError.make({ path, message: `Mode ${mode} must be an object` })
    exactKeys(path, `Mode ${mode}`, config, ["main", "oracle"])
    if (!object(config.main) || !object(config.oracle))
      throw ConfigFileError.make({ path, message: `Mode ${mode} requires main and oracle` })
    for (const [role, route] of [
      ["main", config.main],
      ["oracle", config.oracle],
    ] as const) {
      exactKeys(path, `Mode ${mode} ${role}`, route, ["alias", "effort", "fast"])
      if (
        typeof route.alias !== "string" ||
        !efforts.includes(route.effort as Effort) ||
        (route.fast !== undefined && typeof route.fast !== "boolean")
      )
        throw ConfigFileError.make({ path, message: `Mode ${mode} ${role} requires alias and supported effort` })
    }
  }
  const agents = (value.agents ?? {}) as Record<string, unknown>
  exactKeys(path, "Agents", agents, ["librarian", "painter", "review", "readThread", "task"])
  for (const [agent, route] of Object.entries(agents)) {
    if (!object(route)) throw ConfigFileError.make({ path, message: `Agent ${agent} route must be an object` })
    exactKeys(path, `Agent ${agent}`, route, ["alias", "effort", "fast"])
    if (
      typeof route.alias !== "string" ||
      !efforts.includes(route.effort as Effort) ||
      (route.fast !== undefined && typeof route.fast !== "boolean")
    )
      throw ConfigFileError.make({ path, message: `Agent ${agent} requires alias and supported effort` })
  }
  if (value.compaction !== undefined) {
    if (!object(value.compaction)) throw ConfigFileError.make({ path, message: "Compaction must be an object" })
    exactKeys(path, "Compaction", value.compaction, ["summaryModel"])
    if (value.compaction.summaryModel !== undefined) {
      if (!object(value.compaction.summaryModel))
        throw ConfigFileError.make({ path, message: "Compaction summary model must be an object" })
      exactKeys(path, "Compaction summary model", value.compaction.summaryModel, ["alias", "effort", "fast"])
      const route = value.compaction.summaryModel
      if (
        typeof route.alias !== "string" ||
        !efforts.includes(route.effort as Effort) ||
        (route.fast !== undefined && typeof route.fast !== "boolean")
      )
        throw ConfigFileError.make({
          path,
          message: "Compaction summary model requires alias and supported effort",
        })
    }
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
  gateways: {
    openai: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      auth: { type: "bearer-env", variable: "OPENAI_API_KEY" },
    },
    anthropic: {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      auth: { type: "bearer-env", variable: "ANTHROPIC_API_KEY" },
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
    review: { alias: "review", effort: "high" },
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
