import { supportedEfforts } from "../model-routing/model-catalog"
import { presetIds, presets } from "../model-routing/model-preset"
import {
  isBoolean,
  isNumber,
  isObject,
  isProviderId,
  isString,
  isStringArray,
  type Decoded,
  type ProviderId,
  type UnknownObject,
} from "./decoder-schema"
import { providerDefaults } from "./defaults"
import { DecoderValidation } from "./decoder-validation"

const { exactKeys } = DecoderValidation
const fail: (path: string, message: string) => never = DecoderValidation.fail

const validateIdentity = (path: string, name: string, alias: UnknownObject) => {
  if (alias.supportsMedia !== undefined && !isBoolean(alias.supportsMedia))
    fail(path, `Model alias ${name} supportsMedia must be true or false`)
  if (!isProviderId(alias.provider)) fail(path, `Model alias ${name} provider is unknown`)
  if (
    !isStringArray(alias.candidates) ||
    alias.candidates.length === 0 ||
    alias.candidates.some((candidate) => candidate.length === 0)
  )
    fail(path, `Model alias ${name} candidates must be non-empty strings`)
  if (alias.displayName !== undefined && (!isString(alias.displayName) || alias.displayName.length === 0))
    fail(path, `Model alias ${name} displayName must be a non-empty string`)
}

const validateSource = (path: string, name: string, alias: UnknownObject) => {
  if (alias.preset !== undefined && (!isString(alias.preset) || !presetIds.some((preset) => preset === alias.preset)))
    fail(path, `Model alias ${name} preset must be one of ${presetIds.join(", ")}`)
  const sources = Number(alias.preset !== undefined) + Number(alias.efforts !== undefined)
  if (sources === 0) fail(path, `Model alias ${name} must set preset or efforts. Presets: ${presetIds.join(", ")}`)
  if (sources > 1) fail(path, `Model alias ${name} must set only one of preset or efforts`)
  if (alias.efforts !== undefined && alias.limits === undefined)
    fail(path, `Model alias ${name} must set limits when it sets efforts`)
}

const positiveLimit = (path: string, name: string, limits: UnknownObject, key: string) => {
  if (!isNumber(limits[key]) || limits[key] <= 0)
    fail(path, `Model alias ${name} limits ${key} must be a positive number`)
}

const validateLimits = (path: string, name: string, input: Decoded) => {
  if (input === undefined) return
  if (!isObject(input)) fail(path, `Model alias ${name} limits must be an object`)
  exactKeys(path, `Model alias ${name} limits`, input, [
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "keepRecentTokens",
  ])
  for (const key of ["maxInputTokens", "maxOutputTokens", "keepRecentTokens"]) positiveLimit(path, name, input, key)
  if (input.contextWindow === undefined) return
  positiveLimit(path, name, input, "contextWindow")
  if (isNumber(input.contextWindow) && isNumber(input.maxInputTokens) && input.contextWindow < input.maxInputTokens)
    fail(path, `Model alias ${name} limits contextWindow must be at least maxInputTokens`)
}

const validateVariant = (path: string, label: string, input: Decoded, allowed: ReadonlyArray<string>) => {
  if (!isObject(input)) fail(path, `${label} must set options`)
  const options: Decoded = input.options
  if (!isObject(options)) fail(path, `${label} must set options`)
  const rejected = Object.keys(options).find((key) => !allowed.includes(key))
  if (rejected !== undefined) fail(path, `${label} sets unsupported option ${rejected}`)
}

const validateEffort = (path: string, name: string, effort: string, input: Decoded, allowed: ReadonlyArray<string>) => {
  if (!supportedEfforts.some((supported) => supported === effort))
    fail(path, `Model alias ${name} effort ${effort} must be one of ${supportedEfforts.join(", ")}`)
  if (!isObject(input)) fail(path, `Model alias ${name} effort ${effort} must be an object`)
  exactKeys(path, `Model alias ${name} effort ${effort}`, input, ["normal", "fast"])
  if (input.normal === undefined) fail(path, `Model alias ${name} effort ${effort} must set normal options`)
  for (const [speed, variant] of Object.entries(input))
    validateVariant(path, `Model alias ${name} effort ${effort} ${speed}`, variant, allowed)
}

const validateEfforts = (path: string, name: string, alias: UnknownObject) => {
  if (alias.efforts === undefined) return
  if (!isObject(alias.efforts)) fail(path, `Model alias ${name} efforts must be an object`)
  if (!isProviderId(alias.provider)) fail(path, `Model alias ${name} provider is unknown`)
  const provider: ProviderId = alias.provider
  const protocol = providerDefaults[provider].protocol
  const allowed = presetIds.flatMap((id) => (presets[id].protocols.includes(protocol) ? presets[id].optionKeys : []))
  for (const [effort, variants] of Object.entries(alias.efforts)) validateEffort(path, name, effort, variants, allowed)
}

const validateAlias = (path: string, name: string, input: Decoded) => {
  if (name.length === 0 || !isObject(input)) fail(path, "Model alias names must be non-empty")
  exactKeys(path, `Model alias ${name}`, input, [
    "preset",
    "provider",
    "candidates",
    "displayName",
    "supportsMedia",
    "limits",
    "efforts",
  ])
  validateIdentity(path, name, input)
  validateSource(path, name, input)
  validateLimits(path, name, input.limits)
  validateEfforts(path, name, input)
}

const validateModelAliases = (path: string, value: UnknownObject) => {
  if (value.modelAliases === undefined) return
  if (!isObject(value.modelAliases)) fail(path, "Model aliases must be an object")
  for (const [name, alias] of Object.entries(value.modelAliases)) validateAlias(path, name, alias)
}

export const ModelAliasDecoder = { validate: validateModelAliases }
