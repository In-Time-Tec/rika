import { Function, Schema } from "effect"
import { modeIds } from "../model-routing/behavior-mode"
import { defaults as modelDefaults, presetIds, presets } from "../model-routing/model-preset"
import { supportedEfforts } from "../model-routing/model-catalog"
import type { ModelRoute } from "../model-routing/model-route"
import { providerDefaults } from "./configuration-defaults"
import type { ConfigurationSettingsInput } from "./configuration-settings-input"

export class ConfigurationSettingsFileError extends Schema.TaggedError<ConfigurationSettingsFileError>()(
  "ConfigurationSettingsFileError",
  { path: Schema.String, message: Schema.String },
) {}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const exactKeys = (path: string, label: string, value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined)
    throw ConfigurationSettingsFileError.make({ path, message: `${label} contains unknown key ${unknown}` })
}

const stringMap = (path: string, label: string, value: unknown): Record<string, string> => {
  if (!object(value)) throw ConfigurationSettingsFileError.make({ path, message: `${label} must be an object` })
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string")
      throw ConfigurationSettingsFileError.make({ path, message: `${label} values must be strings` })
    result[key] = entry
  }
  return result
}

const httpUrl = (path: string, label: string, value: unknown) => {
  if (typeof value !== "string")
    throw ConfigurationSettingsFileError.make({ path, message: `${label} must be a string` })
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
  (value: unknown): (path: string) => ConfigurationSettingsInput
  (path: string, value: unknown): ConfigurationSettingsInput
} = Function.dual(2, (path: string, value: unknown): ConfigurationSettingsInput => {
  if (!object(value))
    throw ConfigurationSettingsFileError.make({ path, message: "Configuration must be a JSON object" })
  exactKeys(path, "Configuration", value, [
    "providers",
    "modelAliases",
    "modelRoutes",
    "subagents",
    "keymap",
    "extensionRoots",
    "mcp",
    "notifications",
    "logging",
    "webSearch",
  ])
  if (value.providers !== undefined && !object(value.providers))
    throw ConfigurationSettingsFileError.make({ path, message: "Providers must be an object" })
  exactKeys(path, "Providers", (value.providers ?? {}) as Record<string, unknown>, Object.keys(providerDefaults))
  for (const [name, providerConnection] of Object.entries((value.providers ?? {}) as Record<string, unknown>)) {
    if (!object(providerConnection))
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
          (typeof providerConnection[field] !== "string" || providerConnection[field].length === 0)
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
        const endpoint = new URL(providerConnection.endpoint as string)
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
        if (!object(providerConnection.authRefresh))
          throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} authRefresh must be an object` })
        exactKeys(path, `Provider ${name} authRefresh`, providerConnection.authRefresh, ["command", "args"])
        if (
          typeof providerConnection.authRefresh.command !== "string" ||
          providerConnection.authRefresh.command.length === 0
        )
          throw ConfigurationSettingsFileError.make({
            path,
            message: `Provider ${name} authRefresh command must be a non-empty string`,
          })
        if (
          !Array.isArray(providerConnection.authRefresh.args) ||
          providerConnection.authRefresh.args.some((arg) => typeof arg !== "string")
        )
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
    ])
    if (providerConnection.streamingOnly !== undefined && typeof providerConnection.streamingOnly !== "boolean")
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} streamingOnly must be a boolean` })
    if (providerConnection.promptCaching !== undefined && typeof providerConnection.promptCaching !== "boolean")
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} promptCaching must be a boolean` })
    if (
      providerConnection.apiKeyEnv !== undefined &&
      (typeof providerConnection.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(providerConnection.apiKeyEnv))
    )
      throw ConfigurationSettingsFileError.make({
        path,
        message: `Provider ${name} apiKeyEnv must be an uppercase environment variable`,
      })
    if (providerConnection.baseUrl !== undefined && typeof providerConnection.baseUrl !== "string")
      throw ConfigurationSettingsFileError.make({ path, message: `Provider ${name} baseUrl must be a string` })
    if (
      providerConnection.credentialIdentity !== undefined &&
      (typeof providerConnection.credentialIdentity !== "string" || providerConnection.credentialIdentity.length === 0)
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
    if (!object(value.modelAliases))
      throw ConfigurationSettingsFileError.make({ path, message: "Model aliases must be an object" })
    for (const [name, alias] of Object.entries(value.modelAliases)) {
      if (name.length === 0 || !object(alias))
        throw ConfigurationSettingsFileError.make({ path, message: "Model alias names must be non-empty" })
      if (name in modelDefaults)
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} cannot replace a built-in model alias`,
        })
      exactKeys(path, `Model alias ${name}`, alias, [
        "preset",
        "provider",
        "candidates",
        "displayName",
        "supportsMedia",
        "limits",
        "efforts",
      ])
      if (alias.supportsMedia !== undefined && typeof alias.supportsMedia !== "boolean")
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} supportsMedia must be true or false`,
        })
      if (typeof alias.provider !== "string" || !(alias.provider in providerDefaults))
        throw ConfigurationSettingsFileError.make({ path, message: `Model alias ${name} provider is unknown` })
      if (
        !Array.isArray(alias.candidates) ||
        alias.candidates.length === 0 ||
        alias.candidates.some((candidate) => typeof candidate !== "string" || candidate.length === 0)
      )
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Model alias ${name} candidates must be non-empty strings`,
        })
      if (
        alias.preset !== undefined &&
        (typeof alias.preset !== "string" || !presetIds.some((presetId) => presetId === alias.preset))
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
      if (alias.displayName !== undefined && (typeof alias.displayName !== "string" || alias.displayName.length === 0))
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
        if (!object(alias.limits))
          throw ConfigurationSettingsFileError.make({ path, message: `Model alias ${name} limits must be an object` })
        exactKeys(path, `Model alias ${name} limits`, alias.limits, [
          "contextWindow",
          "maxInputTokens",
          "maxOutputTokens",
          "keepRecentTokens",
        ])
        for (const key of ["maxInputTokens", "maxOutputTokens", "keepRecentTokens"]) {
          const limit = alias.limits[key]
          if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} limits ${key} must be a positive number`,
            })
        }
        const window = alias.limits["contextWindow"]
        if (window !== undefined) {
          if (typeof window !== "number" || !Number.isFinite(window) || window <= 0)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} limits contextWindow must be a positive number`,
            })
          const maxInput = alias.limits["maxInputTokens"]
          if (typeof maxInput === "number" && window < maxInput)
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} limits contextWindow must be at least maxInputTokens`,
            })
        }
      }
      if (alias.efforts !== undefined) {
        if (!object(alias.efforts))
          throw ConfigurationSettingsFileError.make({ path, message: `Model alias ${name} efforts must be an object` })
        const protocol = providerDefaults[alias.provider as ModelRoute.ProviderId].protocol
        const allowed = presetIds.flatMap((id) =>
          presets[id].protocols.includes(protocol) ? presets[id].optionKeys : [],
        )
        for (const [effort, variants] of Object.entries(alias.efforts)) {
          if (!supportedEfforts.some((supportedEffort) => supportedEffort === effort))
            throw ConfigurationSettingsFileError.make({
              path,
              message: `Model alias ${name} effort ${effort} must be one of ${supportedEfforts.join(", ")}`,
            })
          if (!object(variants))
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
            if (!object(variant) || !object((variant as Record<string, unknown>).options))
              throw ConfigurationSettingsFileError.make({
                path,
                message: `Model alias ${name} effort ${effort} ${speed} must set options`,
              })
            const options = (variant as { options: Record<string, unknown> }).options
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
  if (value.modelRoutes !== undefined) {
    if (!object(value.modelRoutes))
      throw ConfigurationSettingsFileError.make({ path, message: "Model routes must be an object" })
    exactKeys(path, "Model routes", value.modelRoutes, ["modes", "title", "agents", "compaction"])
    const roleRoute = (owner: string, route: unknown) => {
      if (typeof route === "string") {
        if (route.length === 0)
          throw ConfigurationSettingsFileError.make({ path, message: `${owner} alias must be non-empty` })
        return
      }
      if (!object(route))
        throw ConfigurationSettingsFileError.make({ path, message: `${owner} must be an alias or an object` })
      exactKeys(path, owner, route, ["alias", "effort", "fast"])
      if (typeof route.alias !== "string" || route.alias.length === 0)
        throw ConfigurationSettingsFileError.make({ path, message: `${owner} alias must be non-empty` })
      if (route.effort !== undefined && !supportedEfforts.some((supportedEffort) => supportedEffort === route.effort))
        throw ConfigurationSettingsFileError.make({
          path,
          message: `${owner} effort must be one of ${supportedEfforts.join(", ")}`,
        })
      if (route.fast !== undefined && typeof route.fast !== "boolean")
        throw ConfigurationSettingsFileError.make({ path, message: `${owner} fast must be true or false` })
    }
    if (value.modelRoutes.modes !== undefined) {
      if (!object(value.modelRoutes.modes))
        throw ConfigurationSettingsFileError.make({ path, message: "Model route modes must be an object" })
      exactKeys(path, "Model route modes", value.modelRoutes.modes, modeIds)
      for (const [mode, roles] of Object.entries(value.modelRoutes.modes)) {
        if (!object(roles))
          throw ConfigurationSettingsFileError.make({ path, message: `Model route mode ${mode} must be an object` })
        exactKeys(path, `Model route mode ${mode}`, roles, ["main", "oracle"])
        for (const [role, route] of Object.entries(roles)) roleRoute(`Model route mode ${mode} ${role}`, route)
      }
    }
    if (value.modelRoutes.title !== undefined) roleRoute("Model route title", value.modelRoutes.title)
    if (value.modelRoutes.agents !== undefined) {
      if (!object(value.modelRoutes.agents))
        throw ConfigurationSettingsFileError.make({ path, message: "Model route agents must be an object" })
      exactKeys(path, "Model route agents", value.modelRoutes.agents, [
        "librarian",
        "painter",
        "readThread",
        "review",
        "surgeon",
        "task",
      ])
      for (const [agent, route] of Object.entries(value.modelRoutes.agents))
        roleRoute(`Model route agent ${agent}`, route)
    }
    if (value.modelRoutes.compaction !== undefined) roleRoute("Model route compaction", value.modelRoutes.compaction)
  }
  if (value.subagents !== undefined) {
    if (!object(value.subagents))
      throw ConfigurationSettingsFileError.make({ path, message: "Subagents must be an object" })
    exactKeys(path, "Subagents", value.subagents, ["maxDepth", "maxSubagents"])
    for (const key of ["maxDepth", "maxSubagents"] as const) {
      const limit = value.subagents[key]
      if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 0 || (limit as number) > 1_024))
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Subagents ${key} must be an integer between 0 and 1024`,
        })
    }
  }
  if (value.keymap !== undefined) stringMap(path, "Keymap", value.keymap)
  if (
    value.extensionRoots !== undefined &&
    (!Array.isArray(value.extensionRoots) || value.extensionRoots.some((root) => typeof root !== "string"))
  )
    throw ConfigurationSettingsFileError.make({ path, message: "Extension roots must be an array of strings" })
  if (value.mcp !== undefined) {
    if (!object(value.mcp)) throw ConfigurationSettingsFileError.make({ path, message: "MCP must be an object" })
    for (const [name, definition] of Object.entries(value.mcp)) {
      if (!object(definition))
        throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} must be an object` })
      if (definition.transport === "command") {
        exactKeys(path, `MCP ${name}`, definition, ["transport", "command", "args", "cwd", "environment", "enabled"])
        if (typeof definition.command !== "string" || definition.command.length === 0)
          throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} command must be a non-empty string` })
        if (!Array.isArray(definition.args) || definition.args.some((argument) => typeof argument !== "string"))
          throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} args must be an array of strings` })
        if (definition.cwd !== undefined && typeof definition.cwd !== "string")
          throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} cwd must be a string` })
        stringMap(path, `MCP ${name} environment`, definition.environment)
      } else if (definition.transport === "remote") {
        exactKeys(path, `MCP ${name}`, definition, ["transport", "url", "headers", "enabled"])
        httpUrl(path, `MCP ${name} url`, definition.url)
        stringMap(path, `MCP ${name} headers`, definition.headers)
      } else {
        throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} transport must be command or remote` })
      }
      if (typeof definition.enabled !== "boolean")
        throw ConfigurationSettingsFileError.make({ path, message: `MCP ${name} enabled must be a boolean` })
    }
  }
  if (value.notifications !== undefined) {
    if (!object(value.notifications))
      throw ConfigurationSettingsFileError.make({ path, message: "Notifications must be an object" })
    exactKeys(path, "Notifications", value.notifications, ["enabled", "command"])
    if (value.notifications.enabled !== undefined && typeof value.notifications.enabled !== "boolean")
      throw ConfigurationSettingsFileError.make({ path, message: "Notifications enabled must be a boolean" })
    if (value.notifications.command !== undefined && typeof value.notifications.command !== "string")
      throw ConfigurationSettingsFileError.make({ path, message: "Notifications command must be a string" })
  }
  if (value.logging !== undefined) {
    if (!object(value.logging))
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
    if (!object(value.webSearch))
      throw ConfigurationSettingsFileError.make({ path, message: "Web search must be an object" })
    exactKeys(path, "Web search", value.webSearch, ["providers"])
    if (!object(value.webSearch.providers))
      throw ConfigurationSettingsFileError.make({ path, message: "Web search providers must be an object" })
    for (const [id, provider] of Object.entries(value.webSearch.providers)) {
      if (id.length === 0)
        throw ConfigurationSettingsFileError.make({
          path,
          message: "Web search provider ID must be a non-empty string",
        })
      if (!object(provider))
        throw ConfigurationSettingsFileError.make({ path, message: `Web search provider ${id} must be an object` })
      exactKeys(path, `Web search provider ${id}`, provider, ["apiKey"])
      if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0)
        throw ConfigurationSettingsFileError.make({
          path,
          message: `Web search provider ${id} apiKey must be a non-empty string`,
        })
    }
  }
  return value as ConfigurationSettingsInput
})
