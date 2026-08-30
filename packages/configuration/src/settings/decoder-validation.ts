import { Schema } from "effect"
import { isObject, isString, type Decoded, type UnknownObject } from "./decoder-schema"

export class ConfigurationSettingsFileError extends Schema.TaggedError<ConfigurationSettingsFileError>()(
  "ConfigurationSettingsFileError",
  { path: Schema.String, message: Schema.String },
) {}

function fail(path: string, message: string): never {
  throw ConfigurationSettingsFileError.make({ path, message })
}

const exactKeys = (path: string, label: string, value: UnknownObject, allowed: ReadonlyArray<string>) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) fail(path, `${label} contains unknown key ${unknown}`)
}

const stringMap = (path: string, label: string, value: Decoded) => {
  if (!isObject(value)) fail(path, `${label} must be an object`)
  for (const entry of Object.values(value)) if (!isString(entry)) fail(path, `${label} values must be strings`)
}

const httpUrl = (path: string, label: string, value: Decoded) => {
  if (!isString(value)) fail(path, `${label} must be a string`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(path, `${label} must be an absolute HTTP or HTTPS URL`)
  }
  if (url.hostname.length === 0 || !["http:", "https:"].includes(url.protocol))
    fail(path, `${label} must be an absolute HTTP or HTTPS URL`)
  if (url.username.length > 0 || url.password.length > 0) fail(path, `${label} cannot contain credentials`)
  return url
}

export const DecoderValidation = { exactKeys, fail, httpUrl, stringMap }
