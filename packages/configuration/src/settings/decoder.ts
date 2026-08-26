import { Function, Schema } from "effect"
import { presetIds, presets } from "../model-routing/model-preset"
import { supportedEfforts } from "../model-routing/model-catalog"
import { providerDefaults } from "./defaults"
import type { ConfigurationSettingsInput } from "./input"

export class ConfigurationSettingsFileError extends Schema.TaggedError<ConfigurationSettingsFileError>()(
  "ConfigurationSettingsFileError",
  { path: Schema.String, message: Schema.String },
) {}

const UnknownObject = Schema.Record(Schema.String, Schema.Unknown)
type UnknownObject = typeof UnknownObject.Type

const isObject = Schema.is(UnknownObject)
const isString = Schema.is(Schema.String)
const isNumber = Schema.is(Schema.Finite)
const isBoolean = Schema.is(Schema.Boolean)
const StringArray = Schema.Array(Schema.String)
const isStringArray = Schema.is(StringArray)
const ProviderId = Schema.Union([
  Schema.Literal("openai"),
  Schema.Literal("anthropic"),
  Schema.Literal("bedrock"),
  Schema.Literal("openrouter"),
])
const Effort = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
])
const isProviderId = Schema.is(ProviderId)
type SettingsEncoded = typeof Schema.Unknown.Encoded

const StringMap = Schema.Record(Schema.String, Schema.String)
const Variant = Schema.Struct({ options: Schema.JsonObject })
const EffortVariants = Schema.Struct({ normal: Variant, fast: Schema.optionalKey(Variant) })
const ModelAlias = Schema.Struct({
  preset: Schema.optionalKey(Schema.String),
  provider: ProviderId,
  candidates: StringArray,
  displayName: Schema.optionalKey(Schema.String),
  supportsMedia: Schema.optionalKey(Schema.Boolean),
  limits: Schema.optionalKey(
    Schema.Struct({
      contextWindow: Schema.optionalKey(Schema.Finite),
      maxInputTokens: Schema.Finite,
      maxOutputTokens: Schema.Finite,
      keepRecentTokens: Schema.Finite,
    }),
  ),
  efforts: Schema.optionalKey(Schema.Record(Schema.String, EffortVariants)),
})
const AliasRoute = Schema.Struct({
  alias: Schema.String,
  effort: Schema.optionalKey(Effort),
  fast: Schema.optionalKey(Schema.Boolean),
})
const DirectRoute = Schema.Struct({
  model: Schema.String,
  provider: ProviderId,
  effort: Schema.optionalKey(Effort),
  fast: Schema.optionalKey(Schema.Boolean),
})
const RoleRoute = Schema.Union([AliasRoute, DirectRoute])
const Agents = Schema.Struct({
  librarian: Schema.optionalKey(RoleRoute),
  painter: Schema.optionalKey(RoleRoute),
  readThread: Schema.optionalKey(RoleRoute),
  review: Schema.optionalKey(RoleRoute),
  surgeon: Schema.optionalKey(RoleRoute),
  task: Schema.optionalKey(RoleRoute),
})
const Mode = Schema.Struct({
  main: Schema.optionalKey(RoleRoute),
  oracle: Schema.optionalKey(RoleRoute),
  agents: Schema.optionalKey(Agents),
})
const McpCommand = Schema.Struct({
  transport: Schema.Literal("command"),
  command: Schema.String,
  args: StringArray,
  cwd: Schema.optionalKey(Schema.String),
  environment: StringMap,
  enabled: Schema.Boolean,
})
const McpRemote = Schema.Struct({
  transport: Schema.Literal("remote"),
  url: Schema.String,
  headers: StringMap,
  enabled: Schema.Boolean,
})
const HttpProviderOverride = Schema.Struct({
  baseUrl: Schema.optionalKey(Schema.String),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  credentialIdentity: Schema.optionalKey(Schema.String),
  streamingOnly: Schema.optionalKey(Schema.Boolean),
  promptCaching: Schema.optionalKey(Schema.Boolean),
  api: Schema.optionalKey(Schema.Union([Schema.Literal("responses"), Schema.Literal("chat-completions")])),
})
const BedrockProviderOverride = Schema.Struct({
  region: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  authMode: Schema.optionalKey(Schema.Union([Schema.Literal("default"), Schema.Literal("bearer")])),
  authRefresh: Schema.optionalKey(Schema.Struct({ command: Schema.String, args: StringArray })),
})
const ConfigurationInput = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({
      openai: Schema.optionalKey(HttpProviderOverride),
      anthropic: Schema.optionalKey(HttpProviderOverride),
      bedrock: Schema.optionalKey(BedrockProviderOverride),
      openrouter: Schema.optionalKey(HttpProviderOverride),
    }),
  ),
  modelAliases: Schema.optionalKey(Schema.Record(Schema.String, ModelAlias)),
  defaultMode: Schema.optionalKey(Schema.String),
  modes: Schema.optionalKey(Schema.Record(Schema.String, Mode)),
  modelRoutes: Schema.optionalKey(
    Schema.Struct({ title: Schema.optionalKey(RoleRoute), compaction: Schema.optionalKey(RoleRoute) }),
  ),
  subagents: Schema.optionalKey(
    Schema.Struct({ maxDepth: Schema.optionalKey(Schema.Finite), maxSubagents: Schema.optionalKey(Schema.Finite) }),
  ),
  keymap: Schema.optionalKey(StringMap),
  extensionRoots: Schema.optionalKey(StringArray),
  mcp: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([McpCommand, McpRemote]))),
  notifications: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean), command: Schema.optionalKey(Schema.String) }),
  ),
  logging: Schema.optionalKey(
    Schema.Struct({
      level: Schema.optionalKey(
        Schema.Union([
          Schema.Literal("debug"),
          Schema.Literal("info"),
          Schema.Literal("warning"),
          Schema.Literal("error"),
        ]),
      ),
    }),
  ),
  webSearch: Schema.optionalKey(
    Schema.Struct({ providers: Schema.Record(Schema.String, Schema.Struct({ apiKey: Schema.String })) }),
  ),
})
const isConfigurationInput = Schema.is(ConfigurationInput)

const exactKeys = (path: string, label: string, value: UnknownObject, allowed: ReadonlyArray<string>) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined)
    throw ConfigurationSettingsFileError.make({ path, message: `${label} contains unknown key ${unknown}` })
}

const stringMap = (path: string, label: string, value: typeof Schema.Unknown.Type) => {
  if (!isObject(value)) throw ConfigurationSettingsFileError.make({ path, message: `${label} must be an object` })
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isString(entry))
      throw ConfigurationSettingsFileError.make({ path, message: `${label} values must be strings` })
    result[key] = entry
  }
  return result
}

const httpUrl = (path: string, label: string, value: typeof Schema.Unknown.Type) => {
  if (!isString(value)) throw ConfigurationSettingsFileError.make({ path, message: `${label} must be a string` })
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw ConfigurationSettingsFileError.make({ path, message: `${label} must be an absolute HTTP or HTTPS URL` })
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0)
    throw ConfigurationSettingsFileError.make({ path, message: `${label} must be an absolute HTTP or HTTPS URL` })
  if (url.username.length > 0 || url.password.length > 0)
    throw ConfigurationSettingsFileError.make({ path, message: `${label} cannot contain credentials` })
}

export const decodeSettingsInput: {
  (value: SettingsEncoded): (path: string) => ConfigurationSettingsInput
  (path: string, value: SettingsEncoded): ConfigurationSettingsInput
} = Function.dual(2, (path: string, encoded: SettingsEncoded): ConfigurationSettingsInput => {
  const value = Schema.decodeUnknownSync(Schema.Unknown)(encoded)
  if (!isObject(value))
    throw ConfigurationSettingsFileError.make({ path, message: "Configuration must be a JSON object" })
  exactKeys(path, "Configuration", value, [
    "providers",
    "modelAliases",
    "defaultMode",
    "modes",
    "modelRoutes",
    "subagents",
    "keymap",
    "extensionRoots",
    "mcp",
    "notifications",
    "logging",
    "webSearch",
  ])
  if (value.providers !== undefined && !isObject(value.providers))
    throw ConfigurationSettingsFileError.make({ path, message: "Providers must be an object" })
  const providers = value.providers ?? {}
  exactKeys(path, "Providers", providers, Object.keys(providerDefaults))
  for (const [name, providerConnection] of Object.entries(providers)) {
    if (!isObject(providerConnection))
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} must be an object` })
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
          (!isString(providerConnection[field]) || providerConnection[field].length === 0)
        )
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} ${field} must be a non-empty string`,
          })
      if (
        providerConnection.authMode !== undefined &&
        providerConnection.authMode !== "default" &&
        providerConnection.authMode !== "bearer"
      )
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Provider ${name} authMode must be default or bearer`,
        })
      if (providerConnection.endpoint !== undefined) {
        httpUrl(path, `Provider ${name} endpoint`, providerConnection.endpoint)
        if (!isString(providerConnection.endpoint))
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} endpoint must be a string`,
          })
        const endpoint = new URL(providerConnection.endpoint)
        if (endpoint.search.length > 0 || endpoint.hash.length > 0)
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} endpoint cannot contain query or fragment`,
          })
        if (
          endpoint.protocol !== "https:" &&
          endpoint.hostname !== "localhost" &&
          endpoint.hostname !== "127.0.0.1" &&
          endpoint.hostname !== "[::1]"
        )
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} endpoint must use HTTPS except on loopback`,
          })
      }
      if (providerConnection.authRefresh !== undefined) {
        if (providerConnection.authMode === "bearer")
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} authRefresh is unavailable in bearer auth mode`,
          })
        if (!isObject(providerConnection.authRefresh))
          throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} authRefresh must be an object` })
        exactKeys(path, `Provider ${name} authRefresh`, providerConnection.authRefresh, ["command", "args"])
        if (!isString(providerConnection.authRefresh.command) || providerConnection.authRefresh.command.length === 0)
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} authRefresh command must be a non-empty string`,
          })
        if (!isStringArray(providerConnection.authRefresh.args))
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} authRefresh args must be an array of strings`,
          })
      }
      continue
    }
    exactKeys(path, `Provider ${name}`, providerConnection, [
      "baseUrl",
      "apiKeyEnv",
      "credentialIdentity",
      "streamingOnly",
      "promptCaching",
      ...(name === "openai" ? ["api"] : []),
    ])
    if (
      providerConnection.api !== undefined &&
      providerConnection.api !== "responses" &&
      providerConnection.api !== "chat-completions"
    )
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} api must be responses or chat-completions`,
      })
    if (providerConnection.streamingOnly !== undefined && !isBoolean(providerConnection.streamingOnly))
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} streamingOnly must be a boolean` })
    if (providerConnection.promptCaching !== undefined && !isBoolean(providerConnection.promptCaching))
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} promptCaching must be a boolean` })
    if (
      providerConnection.apiKeyEnv !== undefined &&
      (!isString(providerConnection.apiKeyEnv) || !/^[A-Z_][A-Z0-9_]*$/.test(providerConnection.apiKeyEnv))
    )
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} apiKeyEnv must be an uppercase environment variable`,
      })
    if (providerConnection.baseUrl !== undefined && !isString(providerConnection.baseUrl))
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} baseUrl must be a string` })
    if (
      providerConnection.credentialIdentity !== undefined &&
      (!isString(providerConnection.credentialIdentity) || providerConnection.credentialIdentity.length === 0)
    )
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} credentialIdentity must be a non-empty string`,
      })
    if (providerConnection.baseUrl === undefined) continue
    if (!/^https?:\/\/[^\s\\]+$/i.test(providerConnection.baseUrl))
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL`,
      })
    let providerUrl: URL
    try {
      providerUrl = new URL(providerConnection.baseUrl)
    } catch {
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL`,
      })
    }
    if ((providerUrl.protocol !== "http:" && providerUrl.protocol !== "https:") || providerUrl.hostname.length === 0)
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL`,
      })
    if (
      providerUrl.username.length > 0 ||
      providerUrl.password.length > 0 ||
      providerUrl.search.length > 0 ||
      providerUrl.hash.length > 0
    )
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} baseUrl cannot contain credentials`,
      })
  }
  if (value.modelAliases !== undefined) {
    if (!isObject(value.modelAliases))
      throw ConfigurationSettingsFileError.make({ path, message: "Model aliases must be an object" })
    for (const [name, alias] of Object.entries(value.modelAliases)) {
      if (name.length === 0 || !isObject(alias))
        throw ConfigurationSettingsFileError.make({ path, message: "Model alias names must be non-empty" })
      exactKeys(path, `Model alias ${name}`, alias, [
        "preset",
        "provider",
        "candidates",
        "displayName",
        "supportsMedia",
        "limits",
        "efforts",
      ])
      if (alias.supportsMedia !== undefined && !isBoolean(alias.supportsMedia))
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} supportsMedia must be true or false`,
        })
      if (!isProviderId(alias.provider))
        throw ConfigurationSettingsFileError.make({ path, message: `Model alias ${name} provider is unknown` })
      if (
        !isStringArray(alias.candidates) ||
        alias.candidates.length === 0 ||
        alias.candidates.some((candidate) => candidate.length === 0)
      )
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} candidates must be non-empty strings`,
        })
      if (
        alias.preset !== undefined &&
        (!isString(alias.preset) || !presetIds.some((presetId) => presetId === alias.preset))
      )
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} preset must be one of ${presetIds.join(", ")}`,
        })
      const sources = [alias.preset, alias.efforts].filter((source) => source !== undefined).length
      if (sources === 0)
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} must set preset or efforts. Presets: ${presetIds.join(", ")}`,
        })
      if (sources > 1)
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} must set only one of preset or efforts`,
        })
      if (alias.displayName !== undefined && (!isString(alias.displayName) || alias.displayName.length === 0))
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} displayName must be a non-empty string`,
        })
      if (alias.efforts !== undefined && alias.limits === undefined)
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} must set limits when it sets efforts`,
        })
      if (alias.limits !== undefined) {
        if (!isObject(alias.limits))
          throw ConfigurationSettingsFileError.make({ path, message: `Model alias ${name} limits must be an object` })
        exactKeys(path, `Model alias ${name} limits`, alias.limits, [
          "contextWindow",
          "maxInputTokens",
          "maxOutputTokens",
          "keepRecentTokens",
        ])
        for (const key of ["maxInputTokens", "maxOutputTokens", "keepRecentTokens"]) {
          const limit = alias.limits[key]
          if (!isNumber(limit) || limit <= 0)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} limits ${key} must be a positive number`,
            })
        }
        const window = alias.limits["contextWindow"]
        if (window !== undefined) {
          if (!isNumber(window) || window <= 0)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} limits contextWindow must be a positive number`,
            })
          const maxInput = alias.limits["maxInputTokens"]
          if (isNumber(maxInput) && window < maxInput)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} limits contextWindow must be at least maxInputTokens`,
            })
        }
      }
      if (alias.efforts !== undefined) {
        if (!isObject(alias.efforts))
          throw ConfigurationSettingsFileError.make({ path, message: `Model alias ${name} efforts must be an object` })
        const protocol = providerDefaults[alias.provider].protocol
        const allowed = presetIds.flatMap((id) =>
          presets[id].protocols.includes(protocol) ? presets[id].optionKeys : [],
        )
        for (const [effort, variants] of Object.entries(alias.efforts)) {
          if (!supportedEfforts.some((supportedEffort) => supportedEffort === effort))
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} effort ${effort} must be one of ${supportedEfforts.join(", ")}`,
            })
          if (!isObject(variants))
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} effort ${effort} must be an object`,
            })
          exactKeys(path, `Model alias ${name} effort ${effort}`, variants, ["normal", "fast"])
          if (variants.normal === undefined)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} effort ${effort} must set normal options`,
            })
          for (const [speed, variant] of Object.entries(variants)) {
            if (!isObject(variant) || !isObject(variant.options))
              throw ConfigurationSettingsFileError.make({
                path,
                message: `Model alias ${name} effort ${effort} ${speed} must set options`,
              })
            const options = variant.options
            const rejected = Object.keys(options).find((key) => !allowed.includes(key))
            if (rejected !== undefined)
              throw ConfigurationSettingsFileError.make({
                path,
                message: `Model alias ${name} effort ${effort} sets ${rejected}, which provider ${alias.provider} (${protocol}) does not accept. Accepted: ${allowed.join(", ")}`,
              })
          }
        }
      }
    }
  }
  const roleRoute = (owner: string, route: typeof Schema.Unknown.Type) => {
    if (!isObject(route))
      throw ConfigurationSettingsFileError.make({ path, message: `${owner} must be a route object` })
    exactKeys(path, owner, route, ["alias", "model", "provider", "effort", "fast"])
    const hasAlias = route.alias !== undefined
    const hasModel = route.model !== undefined
    if (hasAlias === hasModel)
      throw ConfigurationSettingsFileError.make({ path, message: `${owner} must set exactly one of alias or model` })
    if (hasAlias && (!isString(route.alias) || route.alias.length === 0))
      throw ConfigurationSettingsFileError.make({ path, message: `${owner} alias must be non-empty` })
    if (hasModel && (!isString(route.model) || route.model.length === 0))
      throw ConfigurationSettingsFileError.make({ path, message: `${owner} model must be non-empty` })
    if (hasAlias) {
      if (route.provider !== undefined)
        throw ConfigurationSettingsFileError.make({ path, message: `${owner} alias route cannot set provider` })
    } else if (!isProviderId(route.provider)) {
      throw ConfigurationSettingsFileError.make({ path, message: `${owner} direct route must set a known provider` })
    }
    if (route.effort !== undefined && !supportedEfforts.some((supportedEffort) => supportedEffort === route.effort))
      throw ConfigurationSettingsFileError.make({
        path,
        message: `${owner} effort must be one of ${supportedEfforts.join(", ")}`,
      })
    if (route.fast !== undefined && !isBoolean(route.fast))
      throw ConfigurationSettingsFileError.make({ path, message: `${owner} fast must be true or false` })
  }
  if (value.defaultMode !== undefined && (!isString(value.defaultMode) || value.defaultMode.length === 0))
    throw ConfigurationSettingsFileError.make({ path, message: "Default mode must be a non-empty string" })
  if (value.modes !== undefined) {
    if (!isObject(value.modes)) throw ConfigurationSettingsFileError.make({ path, message: "Modes must be an object" })
    if (Object.keys(value.modes).length === 0)
      throw ConfigurationSettingsFileError.make({ path, message: "Modes must not be empty" })
    for (const [mode, configured] of Object.entries(value.modes)) {
      if (mode.length === 0 || !isObject(configured))
        throw ConfigurationSettingsFileError.make({ path, message: "Mode names must be non-empty and map to objects" })
      exactKeys(path, `Mode ${mode}`, configured, ["main", "oracle", "agents"])
      if (configured.main !== undefined) roleRoute(`Mode ${mode} main`, configured.main)
      if (configured.oracle !== undefined) roleRoute(`Mode ${mode} oracle`, configured.oracle)
      if (configured.agents !== undefined) {
        if (!isObject(configured.agents))
          throw ConfigurationSettingsFileError.make({ path, message: `Mode ${mode} agents must be an object` })
        exactKeys(path, `Mode ${mode} agents`, configured.agents, [
          "librarian",
          "painter",
          "readThread",
          "review",
          "surgeon",
          "task",
        ])
        for (const [agent, route] of Object.entries(configured.agents)) roleRoute(`Mode ${mode} agent ${agent}`, route)
      }
    }
  }
  if (value.modelRoutes !== undefined) {
    if (!isObject(value.modelRoutes))
      throw ConfigurationSettingsFileError.make({ path, message: "Model routes must be an object" })
    exactKeys(path, "Model routes", value.modelRoutes, ["title", "compaction"])
    if (value.modelRoutes.title !== undefined) roleRoute("Model route title", value.modelRoutes.title)
    if (value.modelRoutes.compaction !== undefined) roleRoute("Model route compaction", value.modelRoutes.compaction)
  }
  if (value.subagents !== undefined) {
    if (!isObject(value.subagents))
      throw ConfigurationSettingsFileError.make({ path, message: "Subagents must be an object" })
    exactKeys(path, "Subagents", value.subagents, ["maxDepth", "maxSubagents"])
    for (const key of ["maxDepth", "maxSubagents"] as const) {
      const limit = value.subagents[key]
      if (limit !== undefined && (!isNumber(limit) || !Number.isSafeInteger(limit) || limit < 0 || limit > 1_024))
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Subagents ${key} must be an integer between 0 and 1024`,
        })
    }
  }
  if (value.keymap !== undefined) stringMap(path, "Keymap", value.keymap)
  if (value.extensionRoots !== undefined && !isStringArray(value.extensionRoots))
    throw ConfigurationSettingsFileError.make({ path, message: "Extension roots must be an array of strings" })
  if (value.mcp !== undefined) {
    if (!isObject(value.mcp)) throw ConfigurationSettingsFileError.make({ path, message: "MCP must be an object" })
    for (const [name, definition] of Object.entries(value.mcp)) {
      if (!isObject(definition))
        throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} must be an object` })
      if (definition.transport === "command") {
        exactKeys(path, `MCP ${name}`, definition, ["transport", "command", "args", "cwd", "environment", "enabled"])
        if (!isString(definition.command) || definition.command.length === 0)
          throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} command must be a non-empty string` })
        if (!isStringArray(definition.args))
          throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} args must be an array of strings` })
        if (definition.cwd !== undefined && !isString(definition.cwd))
          throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} cwd must be a string` })
        stringMap(path, `MCP ${name} environment`, definition.environment)
      } else if (definition.transport === "remote") {
        exactKeys(path, `MCP ${name}`, definition, ["transport", "url", "headers", "enabled"])
        httpUrl(path, `MCP ${name} url`, definition.url)
        stringMap(path, `MCP ${name} headers`, definition.headers)
      } else {
        throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} transport must be command or remote` })
      }
      if (!isBoolean(definition.enabled))
        throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} enabled must be a boolean` })
    }
  }
  if (value.notifications !== undefined) {
    if (!isObject(value.notifications))
      throw ConfigurationSettingsFileError.make({ path, message: "Notifications must be an object" })
    exactKeys(path, "Notifications", value.notifications, ["enabled", "command"])
    if (value.notifications.enabled !== undefined && !isBoolean(value.notifications.enabled))
      throw ConfigurationSettingsFileError.make({ path, message: "Notifications enabled must be a boolean" })
    if (value.notifications.command !== undefined && !isString(value.notifications.command))
      throw ConfigurationSettingsFileError.make({ path, message: "Notifications command must be a string" })
  }
  if (value.logging !== undefined) {
    if (!isObject(value.logging))
      throw ConfigurationSettingsFileError.make({ path, message: "Logging must be an object" })
    exactKeys(path, "Logging", value.logging, ["level"])
    if (
      value.logging.level !== undefined &&
      value.logging.level !== "debug" &&
      value.logging.level !== "info" &&
      value.logging.level !== "warning" &&
      value.logging.level !== "error"
    )
      throw ConfigurationSettingsFileError.make({
        path,
        message: "Logging level must be debug, info, warning, or error",
      })
  }
  if (value.webSearch !== undefined) {
    if (!isObject(value.webSearch))
      throw ConfigurationSettingsFileError.make({ path, message: "Web search must be an object" })
    exactKeys(path, "Web search", value.webSearch, ["providers"])
    if (!isObject(value.webSearch.providers))
      throw ConfigurationSettingsFileError.make({ path, message: "Web search providers must be an object" })
    for (const [id, provider] of Object.entries(value.webSearch.providers)) {
      if (id.length === 0)
        throw ConfigurationSettingsFileError.make({
          path,
          message: "Web search provider ID must be a non-empty string",
        })
      if (!isObject(provider))
        throw ConfigurationSettingsFileError.make({ path, message: `Web search provider ${id} must be an object` })
      exactKeys(path, `Web search provider ${id}`, provider, ["apiKey"])
      if (!isString(provider.apiKey) || provider.apiKey.length === 0)
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Web search provider ${id} apiKey must be a non-empty string`,
        })
    }
  }
  if (!isConfigurationInput(value))
    throw ConfigurationSettingsFileError.make({ path, message: "Configuration contains an invalid value" })
  return value
})
