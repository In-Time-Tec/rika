import { providerDefaults } from "./defaults"
import { isBoolean, isObject, isString, isStringArray, type Decoded, type UnknownObject } from "./decoder-schema"
import { DecoderValidation } from "./decoder-validation"

const { exactKeys, httpUrl } = DecoderValidation
const fail: (path: string, message: string) => never = DecoderValidation.fail

const validateEndpoint = (path: string, provider: UnknownObject) => {
  if (provider.endpoint === undefined) return
  const endpoint = httpUrl(path, "Provider bedrock endpoint", provider.endpoint)
  if (endpoint.search.length > 0 || endpoint.hash.length > 0)
    fail(path, "Provider bedrock endpoint cannot contain query or fragment")
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  if (endpoint.protocol !== "https:" && !loopback)
    fail(path, "Provider bedrock endpoint must use HTTPS except on loopback")
}

const validateAuthRefresh = (path: string, provider: UnknownObject) => {
  if (provider.authRefresh === undefined) return
  if (provider.authMode === "bearer") fail(path, "Provider bedrock authRefresh is unavailable in bearer auth mode")
  if (!isObject(provider.authRefresh)) fail(path, "Provider bedrock authRefresh must be an object")
  const refresh = provider.authRefresh
  exactKeys(path, "Provider bedrock authRefresh", refresh, ["command", "args"])
  const command: Decoded = refresh.command
  if (!isString(command) || command.length === 0)
    fail(path, "Provider bedrock authRefresh command must be a non-empty string")
  if (!isStringArray(refresh.args)) fail(path, "Provider bedrock authRefresh args must be an array of strings")
}

const validateBedrock = (path: string, provider: UnknownObject) => {
  exactKeys(path, "Provider bedrock", provider, ["region", "profile", "endpoint", "authMode", "authRefresh"])
  for (const field of ["region", "profile"])
    if (provider[field] !== undefined && (!isString(provider[field]) || provider[field].length === 0))
      fail(path, `Provider bedrock ${field} must be a non-empty string`)
  if (provider.authMode !== undefined && provider.authMode !== "default" && provider.authMode !== "bearer")
    fail(path, "Provider bedrock authMode must be default or bearer")
  validateEndpoint(path, provider)
  validateAuthRefresh(path, provider)
}

const validateBaseUrl = (path: string, name: string, value: Decoded) => {
  if (value === undefined) return
  if (!isString(value) || !/^https?:\/\/[^\s\\]+$/i.test(value))
    fail(path, `Provider ${name} baseUrl must be an absolute HTTP or HTTPS URL`)
  const url = httpUrl(path, `Provider ${name} baseUrl`, value)
  if (url.search.length > 0 || url.hash.length > 0) fail(path, `Provider ${name} baseUrl cannot contain credentials`)
}

const validateHttpFields = (path: string, name: string, provider: UnknownObject) => {
  if (provider.api !== undefined && provider.api !== "responses" && provider.api !== "chat-completions")
    fail(path, `Provider ${name} api must be responses or chat-completions`)
  for (const field of ["streamingOnly", "promptCaching"])
    if (provider[field] !== undefined && !isBoolean(provider[field]))
      fail(path, `Provider ${name} ${field} must be a boolean`)
  if (
    provider.apiKeyEnv !== undefined &&
    (!isString(provider.apiKeyEnv) || !/^[A-Z_][A-Z0-9_]*$/.test(provider.apiKeyEnv))
  )
    fail(path, `Provider ${name} apiKeyEnv must be an uppercase environment variable`)
  if (
    provider.credentialIdentity !== undefined &&
    (!isString(provider.credentialIdentity) || provider.credentialIdentity.length === 0)
  )
    fail(path, `Provider ${name} credentialIdentity must be a non-empty string`)
  validateBaseUrl(path, name, provider.baseUrl)
}

const validateHttpProvider = (path: string, name: string, provider: UnknownObject) => {
  exactKeys(path, `Provider ${name}`, provider, [
    "baseUrl",
    "apiKeyEnv",
    "credentialIdentity",
    "streamingOnly",
    "promptCaching",
    ...(name === "openai" ? ["api"] : []),
  ])
  validateHttpFields(path, name, provider)
}

const validateProviders = (path: string, value: UnknownObject) => {
  if (value.providers === undefined) return
  if (!isObject(value.providers)) fail(path, "Providers must be an object")
  exactKeys(path, "Providers", value.providers, Object.keys(providerDefaults))
  for (const [name, provider] of Object.entries(value.providers)) {
    if (!isObject(provider)) fail(path, `Provider ${name} must be an object`)
    if (name === "bedrock") validateBedrock(path, provider)
    else validateHttpProvider(path, name, provider)
  }
}

export const ProviderDecoder = { validate: validateProviders }
