import { readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

const defaultOrbTemplate = "rika-orb"
const defaultOrbIdleTimeoutSeconds = 300
const defaultMode = "smart"
export const defaultTelemetryEndpoint = "http://127.0.0.1:27686"

const modes = ["rush", "smart", "deep1", "deep2", "deep3"] as const
type Mode = (typeof modes)[number]

export const SettingSource = Schema.Literals(["env", "workspace", "user", "default"]).annotate({
  identifier: "Rika.Settings.SettingSource",
})
export type SettingSource = typeof SettingSource.Type

export const SettingKey = Schema.Literals([
  "orb.template",
  "orb.idleTimeoutSeconds",
  "project.default",
  "user.name",
  "mode.default",
  "compaction.auto",
  "compaction.reserved",
  "compaction.prune",
  "compaction.pruneProtect",
  "compaction.pruneMinimum",
  "telemetry.enabled",
  "telemetry.endpoint",
]).annotate({
  identifier: "Rika.Settings.SettingKey",
})
export type SettingKey = typeof SettingKey.Type

export const settingKeys: ReadonlyArray<SettingKey> = [
  "orb.template",
  "orb.idleTimeoutSeconds",
  "project.default",
  "user.name",
  "mode.default",
  "compaction.auto",
  "compaction.reserved",
  "compaction.prune",
  "compaction.pruneProtect",
  "compaction.pruneMinimum",
  "telemetry.enabled",
  "telemetry.endpoint",
]

const opaqueSettingKeys = ["rika.mcpServers", "mcpServers"] as const

export const envNameByKey: Record<SettingKey, string> = {
  "orb.template": "RIKA_ORB_TEMPLATE",
  "orb.idleTimeoutSeconds": "RIKA_ORB_IDLE_TIMEOUT",
  "project.default": "RIKA_ORB_PROJECT",
  "user.name": "RIKA_USER",
  "mode.default": "RIKA_MODE",
  "compaction.auto": "RIKA_COMPACTION_AUTO",
  "compaction.reserved": "RIKA_COMPACTION_RESERVED",
  "compaction.prune": "RIKA_COMPACTION_PRUNE",
  "compaction.pruneProtect": "RIKA_COMPACTION_PRUNE_PROTECT",
  "compaction.pruneMinimum": "RIKA_COMPACTION_PRUNE_MINIMUM",
  "telemetry.enabled": "RIKA_TELEMETRY",
  "telemetry.endpoint": "RIKA_TELEMETRY_ENDPOINT",
}

export type SettingValue = string | number | boolean | null
export type KeymapValue = string | null
export type KeymapEntries = Readonly<Record<string, KeymapValue>>
export type KeymapSources = Readonly<Record<string, Exclude<SettingSource, "env" | "default">>>

export interface Entry {
  readonly key: SettingKey
  readonly env: string
  readonly value: SettingValue
  readonly source: SettingSource
}

export interface Values {
  readonly orb: {
    readonly template: string
    readonly idleTimeoutSeconds: number
  }
  readonly project: {
    readonly default?: string
  }
  readonly user: {
    readonly name: string
  }
  readonly mode: {
    readonly default: Mode
  }
  readonly compaction: {
    readonly auto?: boolean
    readonly reserved?: number
    readonly prune?: boolean
    readonly pruneProtect?: number
    readonly pruneMinimum?: number
  }
  readonly keymap: KeymapEntries
  readonly telemetry: {
    readonly enabled: boolean
    readonly endpoint: string
  }
}

export interface Warning {
  readonly source: Exclude<SettingSource, "env" | "default">
  readonly path: string
  readonly message: string
  readonly key?: string
}

export interface Snapshot {
  readonly values: Values
  readonly sources: Record<SettingKey, SettingSource>
  readonly keymapSources: KeymapSources
  readonly warnings: ReadonlyArray<Warning>
}

export interface Interface {
  readonly snapshot: Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/Settings") {}

export const userSettingsPath = (home: string) => join(home, ".config", "rika", "settings.json")

export const workspaceSettingsPath = (workspaceRoot: string) => join(workspaceRoot, ".rika", "settings.json")

export const layerFromEnv = (env: Record<string, string | undefined>, workspaceRoot: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const loaded = yield* loadFiles(env.HOME ?? homedir(), workspaceRoot)
      return Service.of({
        snapshot: Effect.succeed(resolve(env, loaded)),
      })
    }),
  )

export const layer = layerFromEnv(process.env, process.cwd())

export const snapshot: Effect.Effect<Snapshot, never, Service> = Effect.flatMap(Service, (service) => service.snapshot)

export const loadSnapshotFromEnv = (env: Record<string, string | undefined>, workspaceRoot: string) =>
  Effect.map(loadFiles(env.HOME ?? homedir(), workspaceRoot), (loaded) => resolve(env, loaded))

export const defaultValues = (): Values => ({
  orb: {
    template: defaultOrbTemplate,
    idleTimeoutSeconds: defaultOrbIdleTimeoutSeconds,
  },
  project: {},
  user: {
    name: defaultUserName(),
  },
  mode: {
    default: defaultMode,
  },
  compaction: {},
  keymap: {},
  telemetry: {
    enabled: true,
    endpoint: defaultTelemetryEndpoint,
  },
})

export const entries = (resolved: Snapshot): ReadonlyArray<Entry> =>
  settingKeys.map((key) => ({
    key,
    env: envNameByKey[key],
    value: valueForKey(resolved.values, key),
    source: resolved.sources[key],
  }))

export const validateSettingsText = (
  content: string,
  path: string,
  source: Exclude<SettingSource, "env" | "default">,
): ReadonlyArray<Warning> => parseSettingsContent(content, path, source).warnings

interface LoadedSettings {
  readonly user: Partial<Record<SettingKey, unknown>>
  readonly workspace: Partial<Record<SettingKey, unknown>>
  readonly userKeymap: KeymapEntries
  readonly workspaceKeymap: KeymapEntries
  readonly warnings: ReadonlyArray<Warning>
}

interface ParsedSettings {
  readonly values: Partial<Record<SettingKey, unknown>>
  readonly keymap: KeymapEntries
  readonly warnings: ReadonlyArray<Warning>
}

interface ResolvedValue<A> {
  readonly value: A
  readonly source: SettingSource
}

const loadFiles = (home: string, workspaceRoot: string): Effect.Effect<LoadedSettings> =>
  Effect.gen(function* () {
    const user = yield* loadFile(userSettingsPath(home), "user")
    const workspace = yield* loadFile(workspaceSettingsPath(workspaceRoot), "workspace")
    return {
      user: user.values,
      workspace: workspace.values,
      userKeymap: user.keymap,
      workspaceKeymap: workspace.keymap,
      warnings: [...user.warnings, ...workspace.warnings],
    }
  })

const loadFile = (path: string, source: Exclude<SettingSource, "env" | "default">): Effect.Effect<ParsedSettings> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((content) => parseSettingsContent(content, path, source)),
    Effect.catch((cause) => {
      if (isNotFound(cause)) return Effect.succeed({ values: {}, keymap: {}, warnings: [] })
      return Effect.succeed({
        values: {},
        keymap: {},
        warnings: [{ source, path, message: messageFromUnknown(cause) }],
      })
    }),
  )

const parseSettingsContent = (
  content: string,
  path: string,
  source: Exclude<SettingSource, "env" | "default">,
): ParsedSettings => {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) {
      return {
        values: {},
        keymap: {},
        warnings: [{ source, path, message: "Settings file must contain a JSON object." }],
      }
    }
    return validateRecord(parsed, path, source)
  } catch (cause) {
    return {
      values: {},
      keymap: {},
      warnings: [{ source, path, message: messageFromUnknown(cause) }],
    }
  }
}

const validateRecord = (
  record: Record<string, unknown>,
  path: string,
  source: Exclude<SettingSource, "env" | "default">,
): ParsedSettings => {
  const values: Partial<Record<SettingKey, unknown>> = {}
  const keymap: Record<string, KeymapValue> = {}
  const warnings: Array<Warning> = []
  for (const [key, value] of Object.entries(record)) {
    if (isSettingKey(key)) {
      const validated = validateSettingValue(key, value)
      if (validated.valid) values[key] = validated.value
      else warnings.push({ source, path, key, message: validated.message })
    } else if (key === "keymap") {
      const validated = validateKeymap(value, path, source)
      Object.assign(keymap, validated.values)
      warnings.push(...validated.warnings)
    } else if (!isOpaqueSettingKey(key)) {
      warnings.push({ source, path, key, message: `Unknown setting ${key}.` })
    }
  }
  return { values, keymap, warnings }
}

const resolve = (env: Record<string, string | undefined>, loaded: LoadedSettings): Snapshot => {
  const template = resolveString("orb.template", env.RIKA_ORB_TEMPLATE, loaded, defaultOrbTemplate)
  const idleTimeoutSeconds = resolvePositiveInteger(
    "orb.idleTimeoutSeconds",
    env.RIKA_ORB_IDLE_TIMEOUT,
    loaded,
    defaultOrbIdleTimeoutSeconds,
  )
  const projectDefault = resolveOptionalString("project.default", env.RIKA_ORB_PROJECT, loaded)
  const userName = resolveString("user.name", env.RIKA_USER, loaded, defaultUserName())
  const modeDefault = resolveMode("mode.default", env.RIKA_MODE, loaded, defaultMode)
  const compactionAuto = resolveBooleanOption("compaction.auto", env.RIKA_COMPACTION_AUTO, loaded)
  const compactionReserved = resolveNonNegativeIntegerOption(
    "compaction.reserved",
    env.RIKA_COMPACTION_RESERVED,
    loaded,
  )
  const compactionPrune = resolveBooleanOption("compaction.prune", env.RIKA_COMPACTION_PRUNE, loaded)
  const compactionPruneProtect = resolveNonNegativeIntegerOption(
    "compaction.pruneProtect",
    env.RIKA_COMPACTION_PRUNE_PROTECT,
    loaded,
  )
  const compactionPruneMinimum = resolveNonNegativeIntegerOption(
    "compaction.pruneMinimum",
    env.RIKA_COMPACTION_PRUNE_MINIMUM,
    loaded,
  )
  const telemetryEnabled = resolveTelemetryBoolean("telemetry.enabled", env.RIKA_TELEMETRY, loaded, true)
  const telemetryEndpoint = resolveString(
    "telemetry.endpoint",
    env.RIKA_TELEMETRY_ENDPOINT,
    loaded,
    defaultTelemetryEndpoint,
  )
  const keymap = resolveKeymap(loaded)

  return {
    values: {
      orb: {
        template: template.value,
        idleTimeoutSeconds: idleTimeoutSeconds.value,
      },
      project: projectDefault.value === undefined ? {} : { default: projectDefault.value },
      user: {
        name: userName.value,
      },
      mode: {
        default: modeDefault.value,
      },
      compaction: {
        ...(compactionAuto.value === undefined ? {} : { auto: compactionAuto.value }),
        ...(compactionReserved.value === undefined ? {} : { reserved: compactionReserved.value }),
        ...(compactionPrune.value === undefined ? {} : { prune: compactionPrune.value }),
        ...(compactionPruneProtect.value === undefined ? {} : { pruneProtect: compactionPruneProtect.value }),
        ...(compactionPruneMinimum.value === undefined ? {} : { pruneMinimum: compactionPruneMinimum.value }),
      },
      keymap: keymap.values,
      telemetry: {
        enabled: telemetryEnabled.value,
        endpoint: telemetryEndpoint.value,
      },
    },
    sources: {
      "orb.template": template.source,
      "orb.idleTimeoutSeconds": idleTimeoutSeconds.source,
      "project.default": projectDefault.source,
      "user.name": userName.source,
      "mode.default": modeDefault.source,
      "compaction.auto": compactionAuto.source,
      "compaction.reserved": compactionReserved.source,
      "compaction.prune": compactionPrune.source,
      "compaction.pruneProtect": compactionPruneProtect.source,
      "compaction.pruneMinimum": compactionPruneMinimum.source,
      "telemetry.enabled": telemetryEnabled.source,
      "telemetry.endpoint": telemetryEndpoint.source,
    },
    keymapSources: keymap.sources,
    warnings: loaded.warnings,
  }
}

const resolveString = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: string,
): ResolvedValue<string> => {
  const envString = validString(envValue)
  if (envString !== undefined) return { value: envString, source: "env" }
  const workspace = validString(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validString(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: fallback, source: "default" }
}

const resolveOptionalString = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
): ResolvedValue<string | undefined> => {
  const envString = validString(envValue)
  if (envString !== undefined) return { value: envString, source: "env" }
  const workspace = validString(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validString(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: undefined, source: "default" }
}

const resolveMode = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: Mode,
): ResolvedValue<Mode> => {
  const envMode = validMode(envValue)
  if (envMode !== undefined) return { value: envMode, source: "env" }
  const workspace = validMode(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validMode(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: fallback, source: "default" }
}

const resolvePositiveInteger = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: number,
): ResolvedValue<number> => {
  const envNumber = validPositiveIntegerFromEnv(envValue)
  if (envNumber !== undefined) return { value: envNumber, source: "env" }
  const workspace = validPositiveIntegerSetting(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validPositiveIntegerSetting(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: fallback, source: "default" }
}

const resolveNonNegativeIntegerOption = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
): ResolvedValue<number | undefined> => {
  const envNumber = validNonNegativeIntegerFromEnv(envValue)
  if (envNumber !== undefined) return { value: envNumber, source: "env" }
  const workspace = validNonNegativeIntegerSetting(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validNonNegativeIntegerSetting(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: undefined, source: "default" }
}

const resolveBooleanOption = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
): ResolvedValue<boolean | undefined> => {
  const envBoolean = validStrictBooleanFromEnv(envValue)
  if (envBoolean !== undefined) return { value: envBoolean, source: "env" }
  const workspace = validBooleanSetting(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validBooleanSetting(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: undefined, source: "default" }
}

const resolveTelemetryBoolean = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: boolean,
): ResolvedValue<boolean> => {
  const envBoolean = validToggleFromEnv(envValue)
  if (envBoolean !== undefined) return { value: envBoolean, source: "env" }
  const workspace = validBooleanSetting(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validBooleanSetting(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: fallback, source: "default" }
}

type ValidationResult =
  | { readonly valid: true; readonly value: unknown }
  | { readonly valid: false; readonly message: string }

const validateSettingValue = (key: SettingKey, value: unknown): ValidationResult => {
  if (key === "orb.template" || key === "project.default" || key === "user.name" || key === "telemetry.endpoint") {
    const string = validString(value)
    return string === undefined
      ? { valid: false, message: `Setting ${key} must be a non-empty string.` }
      : { valid: true, value: string }
  }
  if (key === "orb.idleTimeoutSeconds") {
    const integer = validPositiveIntegerSetting(value)
    return integer === undefined
      ? { valid: false, message: `Setting ${key} must be a positive integer.` }
      : { valid: true, value: integer }
  }
  if (key === "mode.default") {
    const mode = validMode(value)
    return mode === undefined
      ? { valid: false, message: `Setting ${key} must be one of ${modes.join(", ")}.` }
      : { valid: true, value: mode }
  }
  if (key === "compaction.auto" || key === "compaction.prune" || key === "telemetry.enabled") {
    const boolean = validBooleanSetting(value)
    return boolean === undefined
      ? { valid: false, message: `Setting ${key} must be a boolean.` }
      : { valid: true, value: boolean }
  }
  const integer = validNonNegativeIntegerSetting(value)
  return integer === undefined
    ? { valid: false, message: `Setting ${key} must be a non-negative integer.` }
    : { valid: true, value: integer }
}

const validateKeymap = (
  value: unknown,
  path: string,
  source: Exclude<SettingSource, "env" | "default">,
): { readonly values: KeymapEntries; readonly warnings: ReadonlyArray<Warning> } => {
  if (!isRecord(value)) {
    return {
      values: {},
      warnings: [{ source, path, key: "keymap", message: "Setting keymap must be a JSON object." }],
    }
  }
  const values: Record<string, KeymapValue> = {}
  const warnings: Array<Warning> = []
  for (const [id, binding] of Object.entries(value)) {
    if (typeof binding === "string") {
      values[id] = binding
    } else if (binding === null) {
      values[id] = null
    } else {
      warnings.push({
        source,
        path,
        key: `keymap.${id}`,
        message: `Setting keymap.${id} must be a chord string or null.`,
      })
    }
  }
  return { values, warnings }
}

const valueForKey = (values: Values, key: SettingKey): SettingValue => {
  if (key === "orb.template") return values.orb.template
  if (key === "orb.idleTimeoutSeconds") return values.orb.idleTimeoutSeconds
  if (key === "project.default") return values.project.default ?? null
  if (key === "user.name") return values.user.name
  if (key === "mode.default") return values.mode.default
  if (key === "compaction.auto") return values.compaction.auto ?? null
  if (key === "compaction.reserved") return values.compaction.reserved ?? null
  if (key === "compaction.prune") return values.compaction.prune ?? null
  if (key === "compaction.pruneProtect") return values.compaction.pruneProtect ?? null
  if (key === "compaction.pruneMinimum") return values.compaction.pruneMinimum ?? null
  if (key === "telemetry.enabled") return values.telemetry.enabled
  return values.telemetry.endpoint
}

const resolveKeymap = (loaded: LoadedSettings): { readonly values: KeymapEntries; readonly sources: KeymapSources } => {
  const values: Record<string, KeymapValue> = {}
  const sources: Record<string, Exclude<SettingSource, "env" | "default">> = {}
  for (const [key, value] of Object.entries(loaded.workspaceKeymap)) {
    values[key] = value
    sources[key] = "workspace"
  }
  for (const [key, value] of Object.entries(loaded.userKeymap)) {
    values[key] = value
    sources[key] = "user"
  }
  return { values, sources }
}

const settingKeySet = new Set<string>(settingKeys)
const opaqueSettingKeySet = new Set<string>(opaqueSettingKeys)

const isSettingKey = (key: string): key is SettingKey => settingKeySet.has(key)

const isOpaqueSettingKey = (key: string) => opaqueSettingKeySet.has(key)

const validString = (value: unknown) => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const defaultUserName = () => userInfo().username

const validMode = (value: unknown): Mode | undefined => {
  if (value === "rush") return value
  if (value === "smart") return value
  if (value === "deep1") return value
  if (value === "deep2") return value
  if (value === "deep3") return value
  return undefined
}

const validBooleanSetting = (value: unknown) => (typeof value === "boolean" ? value : undefined)

const validStrictBooleanFromEnv = (value: string | undefined) => {
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

const validToggleFromEnv = (value: string | undefined) => {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on" ||
    normalized === "enabled" ||
    normalized === "yes"
  ) {
    return true
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off" ||
    normalized === "disabled" ||
    normalized === "no"
  ) {
    return false
  }
  return undefined
}

const validPositiveIntegerSetting = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined

const validNonNegativeIntegerSetting = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const validPositiveIntegerFromEnv = (value: string | undefined) => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const validNonNegativeIntegerFromEnv = (value: string | undefined) => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNotFound = (cause: unknown) =>
  isRecord(cause) && "code" in cause && typeof cause.code === "string" && cause.code === "ENOENT"

const messageFromUnknown = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
