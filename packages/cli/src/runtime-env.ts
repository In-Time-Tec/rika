import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"

export type Env = Record<string, string | undefined>

export interface System {
  readonly readText: (path: string) => Effect.Effect<string, unknown>
}

export interface LoadInput {
  readonly env: Env
  readonly cwd: string
  readonly home?: string
  readonly system?: System
}

export class RuntimeEnvError extends Schema.TaggedErrorClass<RuntimeEnvError>()("RuntimeEnvError", {
  message: Schema.String,
  operation: Schema.String,
  path: Schema.String,
}) {}

export const globalSettingsPath = (home = homedir()) => join(home, ".rika", "settings.json")

export const localEnvPath = (cwd: string) => join(cwd, ".env.local")

export const load = (input: LoadInput): Effect.Effect<Env, RuntimeEnvError> =>
  Effect.gen(function* () {
    const system = input.system ?? liveSystem
    const settingsPath = globalSettingsPath(input.home)
    const envPath = localEnvPath(input.cwd)
    const settingsText = yield* readOptionalText(system, settingsPath, "readSettings")
    const dotEnvText = yield* readOptionalText(system, envPath, "readDotEnvLocal")
    const globalSettingsEnv = settingsText === undefined ? {} : yield* envFromSettingsText(settingsText, settingsPath)
    const dotEnvLocalEnv = dotEnvText === undefined ? {} : parseDotEnv(dotEnvText)

    return mergeEnv({ globalSettingsEnv, dotEnvLocalEnv, processEnv: input.env })
  })

export const formatError = (error: RuntimeEnvError) => `Rika failed: ${error.message}`

export const mergeEnv = (input: {
  readonly globalSettingsEnv?: Env
  readonly dotEnvLocalEnv?: Env
  readonly processEnv?: Env
}): Env => {
  const merged: Record<string, string> = {}
  assignDefined(merged, input.globalSettingsEnv)
  assignDefined(merged, input.dotEnvLocalEnv)
  assignDefined(merged, input.processEnv)
  return merged
}

export const envFromSettingsText = (content: string, path = globalSettingsPath()) =>
  Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: (cause) => new RuntimeEnvError({ message: errorMessage(cause), operation: "parseSettings", path }),
  }).pipe(Effect.flatMap((settings) => envFromSettings(settings, path)))

export const envFromSettings = (settings: unknown, path = globalSettingsPath()): Effect.Effect<Env, RuntimeEnvError> =>
  Effect.gen(function* () {
    if (!isRecord(settings)) {
      return yield* new RuntimeEnvError({
        message: `Invalid Rika settings in ${path}: expected a JSON object`,
        operation: "decodeSettings",
        path,
      })
    }

    return definedEnv({
      RIKA_API_KEY: stringValue(settings, "api_key"),
      RIKA_BASE_URL: stringValue(settings, "base_url"),
    })
  })

export const parseDotEnv = (content: string): Env => {
  const parsed: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed
    const separator = line.indexOf("=")
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim()
    if (!isEnvKey(key)) continue

    parsed[key] = parseDotEnvValue(line.slice(separator + 1).trim())
  }
  return parsed
}

const liveSystem: System = {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
}

const readOptionalText = (system: System, path: string, operation: string) =>
  system.readText(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        isCode(cause, "ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(new RuntimeEnvError({ message: errorMessage(cause), operation, path })),
      onSuccess: (content) => Effect.succeed(content),
    }),
  )

const assignDefined = (target: Record<string, string>, source: Env | undefined) => {
  if (source === undefined) return
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value
  }
}

const definedEnv = (values: Env): Env => {
  const output: Record<string, string> = {}
  assignDefined(output, values)
  return output
}

const stringValue = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const parseDotEnvValue = (value: string) => {
  if (value.length < 2) return stripInlineComment(value)
  const quote = value[0]
  const last = value[value.length - 1]
  if ((quote === "'" || quote === '"' || quote === "`") && quote === last) {
    return value.slice(1, -1)
  }
  return stripInlineComment(value)
}

const stripInlineComment = (value: string) => {
  const commentIndex = value.search(/\s#/)
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trimEnd()
}

const isEnvKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
