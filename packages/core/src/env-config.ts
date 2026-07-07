import { Config, ConfigProvider, Effect, Option } from "effect"

export type Env = Readonly<Record<string, string | undefined>>

export const truthyBooleanValues = ["1", "true", "on", "enabled", "yes"] as const
export const falsyBooleanValues = ["0", "false", "off", "disabled", "no"] as const

const truthyBooleanValueSet = new Set<string>(truthyBooleanValues)
const falsyBooleanValueSet = new Set<string>(falsyBooleanValues)
const invalidBooleanValue = "__RIKA_INVALID_BOOLEAN__"

export const providerFromEnv = (
  env: Env,
  options: { readonly booleanKeys?: ReadonlyArray<string> } = {},
): ConfigProvider.ConfigProvider => ConfigProvider.fromEnv({ env: envRecord(env, options.booleanKeys ?? []) })

export const optional = <A>(
  provider: ConfigProvider.ConfigProvider,
  config: Config.Config<A>,
): Effect.Effect<A | undefined, Config.ConfigError> =>
  Config.option(config)
    .parse(provider)
    .pipe(Effect.map((value) => Option.getOrUndefined(value)))

export const optionalSync = <A>(provider: ConfigProvider.ConfigProvider, config: Config.Config<A>): A | undefined =>
  Effect.runSync(optional(provider, config))

export const boolean = (key: string) => Config.boolean(key)

export const integer = (key: string) => Config.int(key)

export const string = (key: string) => Config.string(key)

export const literals = <const L extends ReadonlyArray<string>>(values: L, key: string) => Config.literals(values, key)

export const optionalDecimalInteger = (
  provider: ConfigProvider.ConfigProvider,
  key: string,
  options: { readonly minimum?: 0 | 1; readonly allowLeadingZero?: boolean } = {},
): Effect.Effect<number | undefined, Config.ConfigError> =>
  optional(provider, string(key)).pipe(
    Effect.flatMap((value) => {
      if (value === undefined) return Effect.succeed(undefined)
      const parsed = parseDecimalInteger(value, options)
      if (parsed !== undefined) return Effect.succeed(parsed)
      return Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message: `Invalid ${key} ${value}` })))
    }),
  )

export const optionalDecimalIntegerSync = (
  provider: ConfigProvider.ConfigProvider,
  key: string,
  options: { readonly minimum?: 0 | 1; readonly allowLeadingZero?: boolean } = {},
): number | undefined => Effect.runSync(optionalDecimalInteger(provider, key, options))

const envRecord = (env: Env, booleanKeys: ReadonlyArray<string>): Record<string, string> => {
  const keys = new Set(booleanKeys)
  const entries = Object.entries(env).flatMap(([key, value]) => {
    if (value === undefined) return []
    return [[key, keys.has(key) ? normalizeBooleanValue(value) : value] as const]
  })
  return Object.fromEntries(entries)
}

const normalizeBooleanValue = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (truthyBooleanValueSet.has(normalized)) return "true"
  if (falsyBooleanValueSet.has(normalized)) return "false"
  return invalidBooleanValue
}

const parseDecimalInteger = (
  value: string | undefined,
  options: { readonly minimum?: 0 | 1; readonly allowLeadingZero?: boolean },
) => {
  if (value === undefined) return undefined
  const pattern = options.allowLeadingZero === false ? /^(0|[1-9]\d*)$/ : /^\d+$/
  if (!pattern.test(value)) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return undefined
  if (options.minimum === 1 && parsed < 1) return undefined
  return parsed
}

export const EnvConfig = {
  boolean,
  falsyBooleanValues,
  integer,
  literals,
  optional,
  optionalDecimalInteger,
  optionalDecimalIntegerSync,
  optionalSync,
  providerFromEnv,
  string,
  truthyBooleanValues,
} as const
