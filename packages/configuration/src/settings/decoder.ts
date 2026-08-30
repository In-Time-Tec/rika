import { Function, Schema } from "effect"
import type { ConfigurationSettingsInput } from "./input"
import {
  isBoolean,
  isConfigurationInput,
  isNumber,
  isObject,
  isString,
  isStringArray,
  type Decoded,
  type UnknownObject,
} from "./decoder-schema"
import { ModelAliasDecoder } from "./decoder-model-aliases"
import { ProviderDecoder } from "./decoder-providers"
import { RouteDecoder } from "./decoder-routes"
import { ConfigurationSettingsFileError, DecoderValidation } from "./decoder-validation"

const { exactKeys, httpUrl, stringMap } = DecoderValidation
const fail: (path: string, message: string) => never = DecoderValidation.fail

export { ConfigurationSettingsFileError }

const rootKeys = [
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
]

const validateSubagents = (path: string, input: Decoded) => {
  if (input === undefined) return
  if (!isObject(input)) fail(path, "Subagents must be an object")
  exactKeys(path, "Subagents", input, ["maxDepth", "maxSubagents"])
  for (const key of ["maxDepth", "maxSubagents"]) {
    const limit: Decoded = input[key]
    if (limit !== undefined && (!isNumber(limit) || !Number.isSafeInteger(limit) || limit < 0 || limit > 1_024))
      fail(path, `Subagents ${key} must be an integer between 0 and 1024`)
  }
}

const validateCommandMcp = (path: string, name: string, definition: UnknownObject) => {
  exactKeys(path, `MCP ${name}`, definition, ["transport", "command", "args", "cwd", "environment", "enabled"])
  if (!isString(definition.command) || definition.command.length === 0)
    fail(path, `MCP ${name} command must be a non-empty string`)
  if (!isStringArray(definition.args)) fail(path, `MCP ${name} args must be an array of strings`)
  if (definition.cwd !== undefined && !isString(definition.cwd)) fail(path, `MCP ${name} cwd must be a string`)
  stringMap(path, `MCP ${name} environment`, definition.environment)
}

const validateRemoteMcp = (path: string, name: string, definition: UnknownObject) => {
  exactKeys(path, `MCP ${name}`, definition, ["transport", "url", "headers", "enabled"])
  httpUrl(path, `MCP ${name} url`, definition.url)
  stringMap(path, `MCP ${name} headers`, definition.headers)
}

const validateMcpDefinition = (path: string, name: string, input: Decoded) => {
  if (!isObject(input)) fail(path, `MCP ${name} must be an object`)
  if (input.transport === "command") validateCommandMcp(path, name, input)
  else if (input.transport === "remote") validateRemoteMcp(path, name, input)
  else fail(path, `MCP ${name} transport must be command or remote`)
  if (!isBoolean(input.enabled)) fail(path, `MCP ${name} enabled must be a boolean`)
}

const validateMcp = (path: string, input: Decoded) => {
  if (input === undefined) return
  if (!isObject(input)) fail(path, "MCP must be an object")
  for (const [name, definition] of Object.entries(input)) validateMcpDefinition(path, name, definition)
}

const validateApplication = (path: string, value: UnknownObject) => {
  validateSubagents(path, value.subagents)
  if (value.keymap !== undefined) stringMap(path, "Keymap", value.keymap)
  if (value.extensionRoots !== undefined && !isStringArray(value.extensionRoots))
    fail(path, "Extension roots must be an array of strings")
  validateMcp(path, value.mcp)
}

const validateNotifications = (path: string, input: Decoded) => {
  if (input === undefined) return
  if (!isObject(input)) fail(path, "Notifications must be an object")
  exactKeys(path, "Notifications", input, ["enabled", "command"])
  if (input.enabled !== undefined && !isBoolean(input.enabled)) fail(path, "Notifications enabled must be a boolean")
  if (input.command !== undefined && !isString(input.command)) fail(path, "Notifications command must be a string")
}

const validateLogging = (path: string, input: Decoded) => {
  if (input === undefined) return
  if (!isObject(input)) fail(path, "Logging must be an object")
  exactKeys(path, "Logging", input, ["level"])
  if (input.level !== undefined && !["debug", "info", "warning", "error"].some((level) => level === input.level))
    fail(path, "Logging level must be debug, info, warning, or error")
}

const validateWebProvider = (path: string, id: string, input: Decoded) => {
  if (id.length === 0) fail(path, "Web search provider ID must be a non-empty string")
  if (!isObject(input)) fail(path, `Web search provider ${id} must be an object`)
  exactKeys(path, `Web search provider ${id}`, input, ["apiKey"])
  const apiKey: Decoded = input.apiKey
  if (!isString(apiKey) || apiKey.length === 0)
    fail(path, `Web search provider ${id} apiKey must be a non-empty string`)
}

const validateWebSearch = (path: string, input: Decoded) => {
  if (input === undefined) return
  if (!isObject(input)) fail(path, "Web search must be an object")
  exactKeys(path, "Web search", input, ["providers"])
  const configuredProviders: Decoded = input.providers
  if (!isObject(configuredProviders)) fail(path, "Web search providers must be an object")
  const providers = configuredProviders
  for (const [id, provider] of Object.entries(providers)) validateWebProvider(path, id, provider)
}

const validateInput = (path: string, value: UnknownObject) => {
  exactKeys(path, "Configuration", value, rootKeys)
  ProviderDecoder.validate(path, value)
  ModelAliasDecoder.validate(path, value)
  RouteDecoder.validate(path, value)
  validateApplication(path, value)
  validateNotifications(path, value.notifications)
  validateLogging(path, value.logging)
  validateWebSearch(path, value.webSearch)
}

type SettingsEncoded = typeof Schema.Unknown.Encoded

export const decodeSettingsInput: {
  (value: SettingsEncoded): (path: string) => ConfigurationSettingsInput
  (path: string, value: SettingsEncoded): ConfigurationSettingsInput
} = Function.dual(2, (path: string, encoded: SettingsEncoded): ConfigurationSettingsInput => {
  const value = Schema.decodeUnknownSync(Schema.Unknown)(encoded)
  if (!isObject(value)) fail(path, "Configuration must be a JSON object")
  validateInput(path, value)
  if (!isConfigurationInput(value)) fail(path, "Configuration contains an invalid value")
  return value
})
