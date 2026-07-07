import { homedir } from "node:os"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import * as EnvConfig from "./env-config"
import * as Settings from "./settings"

export const Mode = Schema.Literals(["rush", "smart", "deep1", "deep2", "deep3"]).annotate({
  identifier: "Rika.Config.Mode",
})
export type Mode = typeof Mode.Type

export const SubagentTools = Schema.Literals(["readonly", "full"]).annotate({
  identifier: "Rika.Config.SubagentTools",
})
export type SubagentTools = typeof SubagentTools.Type

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
  subagent_tools: Schema.optional(SubagentTools),
}).annotate({ identifier: "Rika.Config.Values" })

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly get: Effect.Effect<Values>
  readonly requireEnv: (key: string) => Effect.Effect<string, ConfigError>
  readonly requireSecret: (key: string) => Effect.Effect<Redacted.Redacted, ConfigError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/Config") {}

export const layerFromValues = (values: Values, env: Record<string, string | undefined> = {}) =>
  Layer.succeed(
    Service,
    Service.of({
      get: Effect.succeed(values),
      requireEnv: Effect.fn("Config.requireEnv")(function* (key: string) {
        return yield* requireEnvValue(env, key)
      }),
      requireSecret: Effect.fn("Config.requireSecret")(function* (key: string) {
        const value = yield* requireEnvValue(env, key)
        return Redacted.make(value, { label: key })
      }),
    }),
  )

export const valuesFromEnv = (
  env: Record<string, string | undefined>,
  cwd: string,
): Effect.Effect<Values, ConfigError> =>
  Effect.gen(function* () {
    const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
    const settings = yield* Settings.loadSnapshotFromEnv(env, workspaceRoot).pipe(Effect.mapError(settingsConfigError))
    const subagentTools = yield* parseSubagentTools(env)
    const base: Values = {
      workspace_root: workspaceRoot,
      data_dir: env.RIKA_DATA_DIR ?? `${env.HOME ?? homedir()}/.rika`,
      default_mode: settings.values.mode.default,
      ...(settings.values.compaction.auto === undefined ? {} : { compaction_auto: settings.values.compaction.auto }),
      ...(settings.values.compaction.reserved === undefined
        ? {}
        : { compaction_reserved: settings.values.compaction.reserved }),
      ...(settings.values.compaction.prune === undefined ? {} : { compaction_prune: settings.values.compaction.prune }),
      ...(settings.values.compaction.pruneProtect === undefined
        ? {}
        : { compaction_prune_protect: settings.values.compaction.pruneProtect }),
      ...(settings.values.compaction.pruneMinimum === undefined
        ? {}
        : { compaction_prune_minimum: settings.values.compaction.pruneMinimum }),
      ...(subagentTools === undefined ? {} : { subagent_tools: subagentTools }),
    }
    const values: Values = env.RIKA_DATABASE_URL === undefined ? base : { ...base, database_url: env.RIKA_DATABASE_URL }
    return env.RIKA_BACKEND_ID === undefined ? values : { ...values, backend_id: env.RIKA_BACKEND_ID }
  })

export const layerFromEnv = (env: Record<string, string | undefined>, cwd: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const values = yield* valuesFromEnv(env, cwd)

      return Service.of({
        get: Effect.succeed(values),
        requireEnv: Effect.fn("Config.requireEnv")(function* (key: string) {
          return yield* requireEnvValue(env, key)
        }),
        requireSecret: Effect.fn("Config.requireSecret")(function* (key: string) {
          const value = yield* requireEnvValue(env, key)
          return Redacted.make(value, { label: key })
        }),
      })
    }),
  )

export const layer = Layer.suspend(() => layerFromEnv(process.env, process.cwd()))

export const get = Effect.fn("Config.get")(function* () {
  const config = yield* Service
  return yield* config.get
})

export const requireEnv = Effect.fn("Config.requireEnv.call")(function* (key: string) {
  const config = yield* Service
  return yield* config.requireEnv(key)
})

export const requireSecret = Effect.fn("Config.requireSecret.call")(function* (key: string) {
  const config = yield* Service
  return yield* config.requireSecret(key)
})

export const subagentTools = (values: Values): SubagentTools => values.subagent_tools ?? "readonly"

const parseSubagentTools = (env: Record<string, string | undefined>) =>
  EffectConfig.option(EffectConfig.literals(["readonly", "full"], "RIKA_SUBAGENT_TOOLS"))
    .parse(EnvConfig.providerFromEnv(env))
    .pipe(
      Effect.map((value) => Option.getOrUndefined(value)),
      Effect.mapError(
        () =>
          new ConfigError({
            message: `Invalid RIKA_SUBAGENT_TOOLS ${env.RIKA_SUBAGENT_TOOLS ?? ""}`,
            key: "RIKA_SUBAGENT_TOOLS",
          }),
      ),
    )

const settingsConfigError = (error: Settings.SettingsError) =>
  new ConfigError({
    message: error.message,
    ...(error.key === undefined ? {} : { key: error.key }),
  })

const requireEnvValue = (env: Record<string, string | undefined>, key: string): Effect.Effect<string, ConfigError> => {
  const value = env[key]
  if (value === undefined || value.length === 0) {
    return new ConfigError({ message: `Missing required config value ${key}`, key })
  }
  return Effect.succeed(value)
}
