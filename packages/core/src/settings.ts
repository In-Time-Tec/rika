import { readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Context, Effect, Layer, Option, Result, Schema } from "effect"
import * as EnvConfig from "./env-config"

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
  "memory.autoContext",
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
  "memory.autoContext",
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
  "memory.autoContext": "RIKA_MEMORY_AUTO_CONTEXT",
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
  readonly memory: {
    readonly autoContext: boolean
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
        snapshot: resolve(env, loaded),
      })
    }),
  )

export const layer = Layer.suspend(() => layerFromEnv(process.env, process.cwd()))

export const snapshot: Effect.Effect<Snapshot, never, Service> = Effect.flatMap(Service, (service) => service.snapshot)

export const loadSnapshotFromEnv = (env: Record<string, string | undefined>, workspaceRoot: string) =>
  Effect.flatMap(loadFiles(env.HOME ?? homedir(), workspaceRoot), (loaded) => resolve(env, loaded))

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
  memory: {
    autoContext: false,
  },
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
      Result.match(validateSettingValue(key, value), {
        onSuccess: (validated) => {
          values[key] = validated
        },
        onFailure: (message) => {
          warnings.push({ source, path, key, message })
        },
      })
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

interface ParsedEnv {
  readonly orbTemplate: string | undefined
  readonly orbIdleTimeoutSeconds: number | undefined
  readonly projectDefault: string | undefined
  readonly userName: string | undefined
  readonly modeDefault: Mode | undefined
  readonly compactionAuto: boolean | undefined
  readonly compactionReserved: number | undefined
  readonly compactionPrune: boolean | undefined
  readonly compactionPruneProtect: number | undefined
  readonly compactionPruneMinimum: number | undefined
  readonly memoryAutoContext: boolean | undefined
  readonly telemetryEnabled: boolean | undefined
  readonly telemetryEndpoint: string | undefined
}

const booleanEnvKeys = [
  "RIKA_COMPACTION_AUTO",
  "RIKA_COMPACTION_PRUNE",
  "RIKA_MEMORY_AUTO_CONTEXT",
  "RIKA_TELEMETRY",
] as const

const resolve = (env: Record<string, string | undefined>, loaded: LoadedSettings): Effect.Effect<Snapshot> =>
  Effect.gen(function* () {
    const parsedEnv = yield* parseEnv(env)
    const template = resolveString("orb.template", parsedEnv.orbTemplate, loaded, defaultOrbTemplate)
    const idleTimeoutSeconds = resolvePositiveInteger(
      "orb.idleTimeoutSeconds",
      parsedEnv.orbIdleTimeoutSeconds,
      loaded,
      defaultOrbIdleTimeoutSeconds,
    )
    const projectDefault = resolveOptionalString("project.default", parsedEnv.projectDefault, loaded)
    const userName = resolveString("user.name", parsedEnv.userName, loaded, defaultUserName())
    const modeDefault = resolveMode("mode.default", parsedEnv.modeDefault, loaded, defaultMode)
    const compactionAuto = resolveBooleanOption("compaction.auto", parsedEnv.compactionAuto, loaded)
    const compactionReserved = resolveNonNegativeIntegerOption(
      "compaction.reserved",
      parsedEnv.compactionReserved,
      loaded,
    )
    const compactionPrune = resolveBooleanOption("compaction.prune", parsedEnv.compactionPrune, loaded)
    const compactionPruneProtect = resolveNonNegativeIntegerOption(
      "compaction.pruneProtect",
      parsedEnv.compactionPruneProtect,
      loaded,
    )
    const compactionPruneMinimum = resolveNonNegativeIntegerOption(
      "compaction.pruneMinimum",
      parsedEnv.compactionPruneMinimum,
      loaded,
    )
    const memoryAutoContext = resolveBoolean("memory.autoContext", parsedEnv.memoryAutoContext, loaded, false)
    const telemetryEnabled = resolveBoolean("telemetry.enabled", parsedEnv.telemetryEnabled, loaded, true)
    const telemetryEndpoint = resolveString(
      "telemetry.endpoint",
      parsedEnv.telemetryEndpoint,
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
        memory: {
          autoContext: memoryAutoContext.value,
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
        "memory.autoContext": memoryAutoContext.source,
        "telemetry.enabled": telemetryEnabled.source,
        "telemetry.endpoint": telemetryEndpoint.source,
      },
      keymapSources: keymap.sources,
      warnings: loaded.warnings,
    }
  })

const parseEnv = (env: Record<string, string | undefined>): Effect.Effect<ParsedEnv> => {
  const provider = EnvConfig.providerFromEnv(env, { booleanKeys: booleanEnvKeys })
  return Effect.all({
    orbTemplate: optionalString(provider, "RIKA_ORB_TEMPLATE"),
    orbIdleTimeoutSeconds: optionalPositiveInteger(provider, "RIKA_ORB_IDLE_TIMEOUT"),
    projectDefault: optionalString(provider, "RIKA_ORB_PROJECT"),
    userName: optionalString(provider, "RIKA_USER"),
    modeDefault: EnvConfig.optional(provider, EnvConfig.literals(modes, "RIKA_MODE")),
    compactionAuto: EnvConfig.optional(provider, EnvConfig.boolean("RIKA_COMPACTION_AUTO")),
    compactionReserved: optionalNonNegativeInteger(provider, "RIKA_COMPACTION_RESERVED"),
    compactionPrune: EnvConfig.optional(provider, EnvConfig.boolean("RIKA_COMPACTION_PRUNE")),
    compactionPruneProtect: optionalNonNegativeInteger(provider, "RIKA_COMPACTION_PRUNE_PROTECT"),
    compactionPruneMinimum: optionalNonNegativeInteger(provider, "RIKA_COMPACTION_PRUNE_MINIMUM"),
    memoryAutoContext: EnvConfig.optional(provider, EnvConfig.boolean("RIKA_MEMORY_AUTO_CONTEXT")),
    telemetryEnabled: EnvConfig.optional(provider, EnvConfig.boolean("RIKA_TELEMETRY")),
    telemetryEndpoint: optionalString(provider, "RIKA_TELEMETRY_ENDPOINT"),
  })
}

const optionalString = (provider: ConfigProvider.ConfigProvider, key: string) =>
  EnvConfig.optional(provider, EnvConfig.string(key)).pipe(Effect.map(validString))

const optionalPositiveInteger = (provider: ConfigProvider.ConfigProvider, key: string) =>
  EnvConfig.optionalDecimalInteger(provider, key, { minimum: 1 })

const optionalNonNegativeInteger = (provider: ConfigProvider.ConfigProvider, key: string) =>
  EnvConfig.optionalDecimalInteger(provider, key)

const resolvedOption = <A>(source: SettingSource, value: A | undefined): Option.Option<ResolvedValue<A>> =>
  value === undefined ? Option.none() : Option.some({ value, source })

const resolvePrecedence = <A>(
  env: A | undefined,
  workspace: A | undefined,
  user: A | undefined,
  fallback: ResolvedValue<A>,
): ResolvedValue<A> =>
  Option.getOrElse(
    Option.firstSomeOf([
      resolvedOption("env", env),
      resolvedOption("workspace", workspace),
      resolvedOption("user", user),
    ]),
    () => fallback,
  )

const resolveString = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: string,
): ResolvedValue<string> =>
  resolvePrecedence(validString(envValue), validString(loaded.workspace[key]), validString(loaded.user[key]), {
    value: fallback,
    source: "default",
  })

const resolveOptionalString = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
): ResolvedValue<string | undefined> =>
  resolvePrecedence(validString(envValue), validString(loaded.workspace[key]), validString(loaded.user[key]), {
    value: undefined,
    source: "default",
  })

const resolveMode = (
  key: SettingKey,
  envValue: Mode | undefined,
  loaded: LoadedSettings,
  fallback: Mode,
): ResolvedValue<Mode> =>
  resolvePrecedence(envValue, validMode(loaded.workspace[key]), validMode(loaded.user[key]), {
    value: fallback,
    source: "default",
  })

const resolvePositiveInteger = (
  key: SettingKey,
  envValue: number | undefined,
  loaded: LoadedSettings,
  fallback: number,
): ResolvedValue<number> =>
  resolvePrecedence(
    envValue,
    validPositiveIntegerSetting(loaded.workspace[key]),
    validPositiveIntegerSetting(loaded.user[key]),
    {
      value: fallback,
      source: "default",
    },
  )

const resolveNonNegativeIntegerOption = (
  key: SettingKey,
  envValue: number | undefined,
  loaded: LoadedSettings,
): ResolvedValue<number | undefined> =>
  resolvePrecedence(
    envValue,
    validNonNegativeIntegerSetting(loaded.workspace[key]),
    validNonNegativeIntegerSetting(loaded.user[key]),
    {
      value: undefined,
      source: "default",
    },
  )

const resolveBooleanOption = (
  key: SettingKey,
  envValue: boolean | undefined,
  loaded: LoadedSettings,
): ResolvedValue<boolean | undefined> =>
  resolvePrecedence(envValue, validBooleanSetting(loaded.workspace[key]), validBooleanSetting(loaded.user[key]), {
    value: undefined,
    source: "default",
  })

const resolveBoolean = (
  key: SettingKey,
  envValue: boolean | undefined,
  loaded: LoadedSettings,
  fallback: boolean,
): ResolvedValue<boolean> =>
  resolvePrecedence(envValue, validBooleanSetting(loaded.workspace[key]), validBooleanSetting(loaded.user[key]), {
    value: fallback,
    source: "default",
  })

const validateSettingValue = (key: SettingKey, value: unknown): Result.Result<unknown, string> => {
  if (key === "orb.template" || key === "project.default" || key === "user.name" || key === "telemetry.endpoint") {
    const string = validString(value)
    return string === undefined ? Result.fail(`Setting ${key} must be a non-empty string.`) : Result.succeed(string)
  }
  if (key === "orb.idleTimeoutSeconds") {
    const integer = validPositiveIntegerSetting(value)
    return integer === undefined ? Result.fail(`Setting ${key} must be a positive integer.`) : Result.succeed(integer)
  }
  if (key === "mode.default") {
    const mode = validMode(value)
    return mode === undefined ? Result.fail(`Setting ${key} must be one of ${modes.join(", ")}.`) : Result.succeed(mode)
  }
  if (
    key === "compaction.auto" ||
    key === "compaction.prune" ||
    key === "memory.autoContext" ||
    key === "telemetry.enabled"
  ) {
    const boolean = validBooleanSetting(value)
    return boolean === undefined ? Result.fail(`Setting ${key} must be a boolean.`) : Result.succeed(boolean)
  }
  const integer = validNonNegativeIntegerSetting(value)
  return integer === undefined ? Result.fail(`Setting ${key} must be a non-negative integer.`) : Result.succeed(integer)
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
  if (key === "memory.autoContext") return values.memory.autoContext
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

const validPositiveIntegerSetting = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined

const validNonNegativeIntegerSetting = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNotFound = (cause: unknown) =>
  isRecord(cause) && "code" in cause && typeof cause.code === "string" && cause.code === "ENOENT"

const messageFromUnknown = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
