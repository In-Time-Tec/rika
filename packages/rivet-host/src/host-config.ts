import { EnvConfig } from "@rika/core"
import type { Client, Registry } from "@rivetkit/effect"
import { Config as EffectConfig, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect"

export const HostMode = Schema.Literals(["local", "remote"]).annotate({
  identifier: "Rika.RivetHost.HostConfig.HostMode",
})
export type HostMode = typeof HostMode.Type

export interface Resolved extends Schema.Schema.Type<typeof Resolved> {}
export const Resolved = Schema.Struct({
  mode: HostMode,
  endpoint: Schema.String,
  token: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  no_welcome: Schema.Boolean,
  runner_version: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.HostConfig.Resolved" })

export interface ResolveOptions {
  readonly mode?: HostMode
  readonly endpoint?: string
  readonly token?: string
  readonly namespace?: string
  readonly noWelcome?: boolean
  readonly runnerVersion?: string
}

export class HostConfigError extends Schema.TaggedErrorClass<HostConfigError>()("HostConfigError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly resolve: Effect.Effect<Resolved, HostConfigError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/HostConfig") {}

export const defaultLocalEndpoint = "http://127.0.0.1:6420"

export const resolveEnv = (env: Record<string, string | undefined> = process.env) => resolveOptions({}, env)

export const layerFromEnv = (env: Record<string, string | undefined> = process.env) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve: Effect.suspend(() => resolveEnv(env)),
    }),
  )

export const layer = Layer.suspend(() => layerFromEnv())

export const resolve = Effect.fn("HostConfig.resolve.call")(function* () {
  const service = yield* Service
  return yield* service.resolve
})

export const resolveOptions = Effect.fn("HostConfig.resolveOptions")(function* (
  options: ResolveOptions = {},
  env: Record<string, string | undefined> = process.env,
) {
  const provider = EnvConfig.providerFromEnv(env, { booleanKeys: ["RIKA_RIVET_NO_WELCOME"] })
  const mode = options.mode ?? (yield* parseModeFromEnv(env, provider))
  const configuredEndpoint = options.endpoint ?? env.RIKA_RIVET_ENDPOINT ?? env.RIVET_ENDPOINT
  if (mode === "remote" && configuredEndpoint === undefined) {
    return yield* new HostConfigError({
      message: "Remote Rivet hosting requires RIKA_RIVET_ENDPOINT or RIVET_ENDPOINT",
      key: "RIKA_RIVET_ENDPOINT",
    })
  }
  const endpoint = configuredEndpoint ?? defaultLocalEndpoint
  const token = optionString(options.token ?? env.RIKA_RIVET_TOKEN ?? env.RIVET_TOKEN)
  const namespace = optionString(options.namespace ?? env.RIKA_RIVET_NAMESPACE ?? env.RIVET_NAMESPACE)
  const runnerVersion = optionString(options.runnerVersion ?? env.RIVET_RUNNER_VERSION)
  const noWelcome = options.noWelcome ?? (yield* noWelcomeFromEnv(provider))
  return {
    mode,
    endpoint,
    ...(Option.isNone(token) ? {} : { token: token.value }),
    ...(Option.isNone(namespace) ? {} : { namespace: namespace.value }),
    no_welcome: noWelcome,
    ...(Option.isNone(runnerVersion) ? {} : { runner_version: runnerVersion.value }),
  }
})

export const toRegistryOptions = (host: Resolved): Registry.Options => ({
  endpoint: host.endpoint,
  ...(host.token === undefined ? {} : { token: host.token }),
  ...(host.namespace === undefined ? {} : { namespace: host.namespace }),
  noWelcome: host.no_welcome,
})

export const toClientOptions = (host: Resolved): Client.Options => ({
  endpoint: host.endpoint,
  ...(host.token === undefined ? {} : { token: host.token }),
  ...(host.namespace === undefined ? {} : { namespace: host.namespace }),
})

const parseModeFromEnv = (env: Record<string, string | undefined>, provider: ConfigProvider.ConfigProvider) =>
  EffectConfig.literals(["local", "remote"], "RIKA_RIVET_HOST")
    .pipe(EffectConfig.withDefault("local"))
    .parse(provider)
    .pipe(
      Effect.mapError(
        () =>
          new HostConfigError({
            message: `Invalid RIKA_RIVET_HOST ${env.RIKA_RIVET_HOST ?? ""}`,
            key: "RIKA_RIVET_HOST",
          }),
      ),
    )

const noWelcomeFromEnv = (provider: ConfigProvider.ConfigProvider) =>
  EnvConfig.optional(provider, EnvConfig.boolean("RIKA_RIVET_NO_WELCOME")).pipe(
    Effect.map((value) => value ?? true),
    Effect.mapError(
      () =>
        new HostConfigError({
          message: "Invalid RIKA_RIVET_NO_WELCOME",
          key: "RIKA_RIVET_NO_WELCOME",
        }),
    ),
  )

const optionString = (value: string | undefined) =>
  value === undefined || value.length === 0 ? Option.none<string>() : Option.some(value)
