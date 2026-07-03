import { Config } from "@rika/core"
import { OrbManager } from "@rika/orb"
import { Database, OrbStore } from "@rika/persistence"
import { Ids, Orb, Remote } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as LocalBackend from "./local-backend"

export type BackendEndpoint = LocalBackend.BackendEndpoint
export const BackendEndpoint = LocalBackend.BackendEndpoint

export interface ResolveInput {
  readonly thread_id?: Ids.ThreadId
  readonly workspace_root: string
  readonly data_dir?: string
  readonly mode?: Config.Mode
  readonly env: Record<string, string | undefined>
}

export class BackendEndpointError extends Schema.TaggedErrorClass<BackendEndpointError>()("BackendEndpointError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export type ResolveError =
  | BackendEndpointError
  | Config.ConfigError
  | Database.DatabaseError
  | LocalBackend.BackendError
  | OrbManager.OrbProvisionError
  | OrbStore.OrbStoreError

export interface HealthInterface {
  readonly health: (url: string, token: string) => Effect.Effect<Remote.BackendHealth, BackendEndpointError>
}

export class Health extends Context.Service<Health, HealthInterface>()("@rika/cli/BackendEndpoint/Health") {}

export interface OrbResumerInterface {
  readonly resume: (orbId: Ids.OrbId) => Effect.Effect<Orb.OrbRecord, OrbManager.OrbProvisionError>
}

export class OrbResumer extends Context.Service<OrbResumer, OrbResumerInterface>()(
  "@rika/cli/BackendEndpoint/OrbResumer",
) {}

export interface ResolverInterface {
  readonly resolveEndpoint: (input: ResolveInput) => Effect.Effect<BackendEndpoint, ResolveError>
}

export class Resolver extends Context.Service<Resolver, ResolverInterface>()("@rika/cli/BackendEndpoint/Resolver") {}

export const healthLayer = Layer.succeed(
  Health,
  Health.of({
    health: Effect.fn("Cli.BackendEndpoint.Health.health")(function* (url: string, token: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
            headers: token.length === 0 ? {} : { authorization: `Bearer ${token}` },
          })
          if (!response.ok) throw new Error(`Health check failed with status ${response.status}`)
          return Schema.decodeUnknownSync(Remote.BackendHealth)(await response.json())
        },
        catch: (cause) =>
          new BackendEndpointError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation: "health",
          }),
      })
    }),
  }),
)

export const orbManagerResumerLayer = Layer.effect(
  OrbResumer,
  Effect.map(OrbManager.Service, (manager) => OrbResumer.of({ resume: manager.resume })),
)

export const resolverLayerFromEnv = (env?: Record<string, string | undefined>) =>
  Layer.effect(
    Resolver,
    Effect.gen(function* () {
      const localBackend = yield* LocalBackend.Service
      const orbs = yield* OrbStore.Service
      const health = yield* Health
      const resumer = yield* OrbResumer
      return Resolver.of({
        resolveEndpoint: (input) =>
          resolveEndpoint({ ...input, env: env ?? input.env }).pipe(
            Effect.provideService(LocalBackend.Service, localBackend),
            Effect.provideService(OrbStore.Service, orbs),
            Effect.provideService(Health, health),
            Effect.provideService(OrbResumer, resumer),
          ),
      })
    }),
  )

export const resolverLayer = resolverLayerFromEnv()

export const resolve = Effect.fn("Cli.BackendEndpoint.Resolver.resolve")(function* (input: ResolveInput) {
  const resolver = yield* Resolver
  return yield* resolver.resolveEndpoint(input)
})

export const resolveEndpoint = Effect.fn("Cli.BackendEndpoint.resolveEndpoint")(function* (input: ResolveInput) {
  const configValues = yield* Config.valuesFromEnv(input.env, input.workspace_root)
  const dataDir = input.data_dir ?? configValues.data_dir
  const mode = input.mode ?? configValues.default_mode
  const localBackend = yield* LocalBackend.Service
  const orbs = yield* OrbStore.Service
  const health = yield* Health
  const resumer = yield* OrbResumer

  if (input.thread_id !== undefined) {
    const orb = yield* orbs.getByThread(input.thread_id)
    if (orb?.status === "paused") {
      const resumed = yield* resumer.resume(orb.orb_id)
      return yield* orbEndpoint(orbs, health, resumed, input.thread_id)
    }
    if (orb?.status === "running") {
      return yield* orbEndpoint(orbs, health, orb, input.thread_id)
    }
  }

  const envEndpoint = endpointFromEnv(input.env)
  if (envEndpoint !== undefined) {
    yield* health.health(envEndpoint.url, envEndpoint.token)
    return envEndpoint
  }

  return yield* localBackend.connectOrStart({
    workspace_root: input.workspace_root,
    data_dir: dataDir,
    mode,
  })
})

const orbEndpoint = Effect.fn("Cli.BackendEndpoint.orbEndpoint")(function* (
  orbs: OrbStore.Interface,
  health: HealthInterface,
  orb: Orb.OrbRecord,
  threadId: Ids.ThreadId,
) {
  const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
  if (endpoint === undefined) {
    return yield* new BackendEndpointError({
      message: `Orb for thread ${threadId} has no endpoint`,
      operation: "resolveEndpoint",
      thread_id: threadId,
    })
  }
  yield* health.health(endpoint.endpoint_url, endpoint.token)
  return {
    kind: "orb" as const,
    url: endpoint.endpoint_url.replace(/\/$/, ""),
    token: endpoint.token,
    orb_id: orb.orb_id,
    thread_id: orb.thread_id,
  }
})

const endpointFromEnv = (env: Record<string, string | undefined>): BackendEndpoint | undefined => {
  if (env.RIKA_BACKEND_URL === undefined || env.RIKA_BACKEND_URL.length === 0) return undefined
  return {
    kind: "env",
    url: env.RIKA_BACKEND_URL.replace(/\/$/, ""),
    token: env.RIKA_BACKEND_TOKEN ?? "",
  }
}
