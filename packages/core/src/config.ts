import { Context, Effect, Layer, Option, Schema } from "effect"

export const Mode = Schema.Literals(["rush", "smart", "deep1", "deep2", "deep3"]).annotate({
  identifier: "Rika.Config.Mode",
})
export type Mode = typeof Mode.Type

export interface Values extends Schema.Schema.Type<typeof Values> {}
export const Values = Schema.Struct({
  workspace_root: Schema.String,
  data_dir: Schema.String,
  default_mode: Mode,
  database_url: Schema.optional(Schema.String),
  backend_id: Schema.optional(Schema.String),
  compaction_auto: Schema.optional(Schema.Boolean),
  compaction_reserved: Schema.optional(Schema.Int),
  compaction_prune: Schema.optional(Schema.Boolean),
  compaction_prune_protect: Schema.optional(Schema.Int),
  compaction_prune_minimum: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Config.Values" })

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly get: Effect.Effect<Values>
  readonly requireEnv: (key: string) => Effect.Effect<string, ConfigError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/Config") {}

export const layerFromValues = (values: Values, env: Record<string, string | undefined> = {}) =>
  Layer.succeed(
    Service,
    Service.of({
      get: Effect.succeed(values),
      requireEnv: Effect.fn("Config.requireEnv")(function* (key: string) {
        const value = env[key]
        if (value === undefined || value.length === 0) {
          return yield* new ConfigError({ message: `Missing required config value ${key}`, key })
        }
        return value
      }),
    }),
  )

export const layerFromEnv = (env: Record<string, string | undefined>, cwd: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const defaultMode = yield* parseMode(env.RIKA_MODE ?? "smart")
      const compactionAuto = yield* parseBooleanOption(env.RIKA_COMPACTION_AUTO, "RIKA_COMPACTION_AUTO")
      const compactionReserved = yield* parseNonNegativeIntOption(
        env.RIKA_COMPACTION_RESERVED,
        "RIKA_COMPACTION_RESERVED",
      )
      const compactionPrune = yield* parseBooleanOption(env.RIKA_COMPACTION_PRUNE, "RIKA_COMPACTION_PRUNE")
      const compactionPruneProtect = yield* parseNonNegativeIntOption(
        env.RIKA_COMPACTION_PRUNE_PROTECT,
        "RIKA_COMPACTION_PRUNE_PROTECT",
      )
      const compactionPruneMinimum = yield* parseNonNegativeIntOption(
        env.RIKA_COMPACTION_PRUNE_MINIMUM,
        "RIKA_COMPACTION_PRUNE_MINIMUM",
      )
      const base: Values = {
        workspace_root: env.RIKA_WORKSPACE_ROOT ?? cwd,
        data_dir: env.RIKA_DATA_DIR ?? `${cwd}/.rika`,
        default_mode: defaultMode,
        ...(compactionAuto === undefined ? {} : { compaction_auto: compactionAuto }),
        ...(compactionReserved === undefined ? {} : { compaction_reserved: compactionReserved }),
        ...(compactionPrune === undefined ? {} : { compaction_prune: compactionPrune }),
        ...(compactionPruneProtect === undefined ? {} : { compaction_prune_protect: compactionPruneProtect }),
        ...(compactionPruneMinimum === undefined ? {} : { compaction_prune_minimum: compactionPruneMinimum }),
      }
      const values: Values =
        env.RIKA_DATABASE_URL === undefined ? base : { ...base, database_url: env.RIKA_DATABASE_URL }
      const withBackendId: Values =
        env.RIKA_BACKEND_ID === undefined ? values : { ...values, backend_id: env.RIKA_BACKEND_ID }

      return Service.of({
        get: Effect.succeed(withBackendId),
        requireEnv: Effect.fn("Config.requireEnv")(function* (key: string) {
          const value = env[key]
          if (value === undefined || value.length === 0) {
            return yield* new ConfigError({ message: `Missing required config value ${key}`, key })
          }
          return value
        }),
      })
    }),
  )

export const layer = layerFromEnv(process.env, process.cwd())

export const get = Effect.fn("Config.get")(function* () {
  const config = yield* Service
  return yield* config.get
})

export const requireEnv = Effect.fn("Config.requireEnv.call")(function* (key: string) {
  const config = yield* Service
  return yield* config.requireEnv(key)
})

const parseMode = (value: string) => {
  const decoded = Schema.decodeUnknownOption(Mode)(value)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return new ConfigError({ message: `Invalid RIKA_MODE ${value}`, key: "RIKA_MODE" })
}

const parseBooleanOption = (value: string | undefined, key: string) => {
  if (value === undefined) return Effect.succeed(undefined)
  if (value === "true") return Effect.succeed(true)
  if (value === "false") return Effect.succeed(false)
  return new ConfigError({ message: `Invalid ${key} ${value}`, key })
}

const parseNonNegativeIntOption = (value: string | undefined, key: string) => {
  if (value === undefined) return Effect.succeed(undefined)
  if (!/^\d+$/.test(value)) return new ConfigError({ message: `Invalid ${key} ${value}`, key })
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed)) return Effect.succeed(parsed)
  return new ConfigError({ message: `Invalid ${key} ${value}`, key })
}
