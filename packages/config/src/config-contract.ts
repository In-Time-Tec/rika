import { Schema, type Redacted } from "effect"

export type ModeId = "low" | "medium" | "high" | "ultra"
export type Role = "main" | "oracle"
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
  readonly compaction: {
    readonly contextWindow: number
    readonly reserveTokens: number
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
  readonly budget: number
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
  readonly keymap: Readonly<Record<string, string>>
  readonly permissions: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots: ReadonlyArray<string>
  readonly mcp: Readonly<Record<string, McpDefinition>>
  readonly notifications: { readonly enabled: boolean; readonly command?: string }
  readonly logging: { readonly level: LogLevel; readonly file?: string }
}

export interface SettingsInput {
  readonly gateways?: Readonly<Record<string, GatewayConnection>>
  readonly models?: Readonly<Record<string, ModelAlias>>
  readonly modes?: Partial<Readonly<Record<ModeId, ModeConfig>>>
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
  readonly compaction: ModelAlias["compaction"]
  readonly options: Readonly<Record<string, unknown>>
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const exactKeys = (path: string, label: string, value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new ConfigFileError({ path, message: `${label} contains unknown key ${unknown}` })
}

const positiveInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const efforts: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"]

export const resolveModelRoute = (settings: Settings, mode: ModeId, role: Role = "main"): ResolvedModelRoute => {
  const route = settings.modes[mode][role]
  const alias = settings.models[route.alias]
  if (alias === undefined)
    throw new ModelRouteError({ mode, message: `Mode ${mode} ${role} references missing model alias ${route.alias}` })
  const gateway = settings.gateways[alias.gateway]
  if (gateway === undefined)
    throw new ModelRouteError({
      mode,
      message: `Model alias ${route.alias} references missing gateway ${alias.gateway}`,
    })
  const variant = alias.variants[route.effort]?.[route.fast === true ? "fast" : "normal"]
  if (variant === undefined)
    throw new ModelRouteError({
      mode,
      message: `Mode ${mode} ${role} requests unavailable ${route.alias}/${route.effort}${route.fast === true ? "/fast" : ""} variant`,
    })
  return {
    alias: route.alias,
    effort: route.effort,
    fast: route.fast === true,
    gatewayName: alias.gateway,
    gateway,
    candidates: alias.candidates,
    model: alias.candidates[0]!,
    compaction: alias.compaction,
    options: variant.options,
  }
}

export const decodeSettingsInput = (path: string, value: unknown): SettingsInput => {
  if (!object(value)) throw new ConfigFileError({ path, message: "Configuration must be a JSON object" })
  exactKeys(path, "Configuration", value, [
    "gateways",
    "models",
    "modes",
    "keymap",
    "permissions",
    "extensionRoots",
    "mcp",
    "notifications",
    "logging",
  ])
  for (const [name, gateway] of Object.entries((value.gateways ?? {}) as Record<string, unknown>)) {
    if (!object(gateway)) throw new ConfigFileError({ path, message: `Gateway ${name} must be an object` })
    if (gateway.protocol !== "openai" && gateway.protocol !== "anthropic")
      throw new ConfigFileError({ path, message: `Gateway ${name} requires an explicit supported protocol` })
    exactKeys(path, `Gateway ${name}`, gateway, ["protocol", "baseUrl", "auth"])
    if (!object(gateway.auth) || (gateway.auth.type !== "none" && gateway.auth.type !== "bearer-env"))
      throw new ConfigFileError({ path, message: `Gateway ${name} auth must be none or bearer-env` })
    exactKeys(path, `Gateway ${name} auth`, gateway.auth, ["type", "variable"])
    if (
      gateway.auth.type === "bearer-env" &&
      (typeof gateway.auth.variable !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(gateway.auth.variable))
    )
      throw new ConfigFileError({ path, message: `Gateway ${name} bearer-env auth requires an environment variable` })
    if (gateway.auth.type === "none" && gateway.auth.variable !== undefined)
      throw new ConfigFileError({ path, message: `Gateway ${name} none auth cannot name an environment variable` })
    if (typeof gateway.baseUrl !== "string")
      throw new ConfigFileError({ path, message: `Gateway ${name} baseUrl must be a string` })
  }
  for (const [name, model] of Object.entries((value.models ?? {}) as Record<string, unknown>)) {
    if (!object(model)) throw new ConfigFileError({ path, message: `Model alias ${name} must be an object` })
    exactKeys(path, `Model alias ${name}`, model, ["gateway", "candidates", "compaction", "variants"])
    if (
      typeof model.gateway !== "string" ||
      !Array.isArray(model.candidates) ||
      model.candidates.length === 0 ||
      model.candidates.some((id) => typeof id !== "string")
    )
      throw new ConfigFileError({
        path,
        message: `Model alias ${name} requires gateway and non-empty string candidates`,
      })
    if (!object(model.compaction))
      throw new ConfigFileError({ path, message: `Model alias ${name} requires valid operational compaction limits` })
    const { contextWindow, reserveTokens, keepRecentTokens } = model.compaction
    if (
      !positiveInteger(contextWindow) ||
      !positiveInteger(reserveTokens) ||
      !positiveInteger(keepRecentTokens) ||
      (reserveTokens as number) + (keepRecentTokens as number) >= (contextWindow as number)
    )
      throw new ConfigFileError({ path, message: `Model alias ${name} requires valid operational compaction limits` })
    exactKeys(path, `Model alias ${name} compaction`, model.compaction, [
      "contextWindow",
      "reserveTokens",
      "keepRecentTokens",
    ])
    if (!object(model.variants) || Object.keys(model.variants).length === 0)
      throw new ConfigFileError({ path, message: `Model alias ${name} requires variants` })
    for (const [effort, variants] of Object.entries(model.variants)) {
      if (!efforts.includes(effort as Effort) || !object(variants) || !object(variants.normal))
        throw new ConfigFileError({ path, message: `Model alias ${name} has invalid effort variant ${effort}` })
      exactKeys(path, `Model alias ${name} ${effort}`, variants, ["normal", "fast"])
      for (const variant of [variants.normal, variants.fast].filter((item) => item !== undefined)) {
        if (!object(variant) || !object(variant.options))
          throw new ConfigFileError({ path, message: `Model alias ${name} ${effort} variant requires options` })
        exactKeys(path, `Model alias ${name} ${effort} variant`, variant, ["options"])
      }
    }
  }
  for (const [mode, config] of Object.entries((value.modes ?? {}) as Record<string, unknown>)) {
    if (!object(config)) throw new ConfigFileError({ path, message: `Mode ${mode} must be an object` })
    exactKeys(path, `Mode ${mode}`, config, ["budget", "main", "oracle"])
    if (!positiveInteger(config.budget) || !object(config.main) || !object(config.oracle))
      throw new ConfigFileError({ path, message: `Mode ${mode} requires budget, main, and oracle` })
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
        throw new ConfigFileError({ path, message: `Mode ${mode} ${role} requires alias and supported effort` })
    }
  }
  return value as SettingsInput
}

const gptCompaction = { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 }
const claudeCompaction = { contextWindow: 1_000_000, reserveTokens: 128_000, keepRecentTokens: 64_000 }
const gptVariants = Object.fromEntries(
  efforts.map((effort) => [
    effort,
    {
      normal: { options: { reasoning: { effort }, max_output_tokens: 128_000 } },
      fast: { options: { reasoning: { effort }, max_output_tokens: 128_000, service_tier: "priority" } },
    },
  ]),
) as ModelAlias["variants"]
const claudeVariants = Object.fromEntries(
  efforts.map((effort) => [effort, { normal: { options: { output_config: { effort }, max_tokens: 128_000 } } }]),
) as ModelAlias["variants"]

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
  models: {
    luna: { gateway: "openai", candidates: ["gpt-5.6-luna"], compaction: gptCompaction, variants: gptVariants },
    terra: { gateway: "openai", candidates: ["gpt-5.6-terra"], compaction: gptCompaction, variants: gptVariants },
    sol: { gateway: "openai", candidates: ["gpt-5.6-sol"], compaction: gptCompaction, variants: gptVariants },
    fable: {
      gateway: "anthropic",
      candidates: ["claude-fable-5", "claude-opus-4-8"],
      compaction: claudeCompaction,
      variants: claudeVariants,
    },
    opus: {
      gateway: "anthropic",
      candidates: ["claude-opus-4-8"],
      compaction: claudeCompaction,
      variants: claudeVariants,
    },
  },
  modes: {
    low: { budget: 32, main: { alias: "luna", effort: "low" }, oracle: { alias: "sol", effort: "high" } },
    medium: { budget: 64, main: { alias: "terra", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
    high: { budget: 128, main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "fable", effort: "max" } },
    ultra: { budget: 256, main: { alias: "fable", effort: "max" }, oracle: { alias: "sol", effort: "max" } },
  },
  keymap: { mode: "ctrl+s", palette: "ctrl+p", submit: "enter", newline: "shift+enter", interrupt: "escape" },
  permissions: { read: "allow", search: "allow", write: "allow", shell: "allow", external: "allow" },
  extensionRoots: ["~/.config/rika/extensions", ".rika/extensions"],
  mcp: {},
  notifications: { enabled: true },
  logging: { level: "info" },
}
