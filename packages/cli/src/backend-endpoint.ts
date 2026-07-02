import { Config } from "@rika/core"
import { Database, OrbStore } from "@rika/persistence"
import { Ids, Remote } from "@rika/schema"
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
  | Database.DatabaseError
  | LocalBackend.BackendError
  | OrbStore.OrbStoreError

export interface HealthInterface {
  readonly health: (url: string, token: string) => Effect.Effect<Remote.BackendHealth, BackendEndpointError>
}

export class Health extends Context.Service<Health, HealthInterface>()("@rika/cli/BackendEndpoint/Health") {}

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

export const resolverLayerFromEnv = (env?: Record<string, string | undefined>) =>
  Layer.effect(
    Resolver,
    Effect.gen(function* () {
      const localBackend = yield* LocalBackend.Service
      const orbs = yield* OrbStore.Service
      const health = yield* Health
      return Resolver.of({
        resolveEndpoint: (input) =>
          resolveEndpoint({ ...input, env: env ?? input.env }).pipe(
            Effect.provideService(LocalBackend.Service, localBackend),
            Effect.provideService(OrbStore.Service, orbs),
            Effect.provideService(Health, health),
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
  const dataDir = input.data_dir ?? input.env.RIKA_DATA_DIR ?? `${input.workspace_root}/.rika`
  const mode = input.mode ?? modeFromEnv(input.env)
  const localBackend = yield* LocalBackend.Service
  const orbs = yield* OrbStore.Service
  const health = yield* Health

  if (input.thread_id !== undefined) {
    const orb = yield* orbs.getByThread(input.thread_id)
    if (orb?.status === "paused") {
      return yield* new BackendEndpointError({
        message: `Orb for thread ${input.thread_id} is paused`,
        operation: "resolveEndpoint",
        thread_id: input.thread_id,
      })
    }
    if (orb?.status === "running") {
      const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
      if (endpoint === undefined) {
        return yield* new BackendEndpointError({
          message: `Orb for thread ${input.thread_id} has no endpoint`,
          operation: "resolveEndpoint",
          thread_id: input.thread_id,
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

const endpointFromEnv = (env: Record<string, string | undefined>): BackendEndpoint | undefined => {
  if (env.RIKA_BACKEND_URL === undefined || env.RIKA_BACKEND_URL.length === 0) return undefined
  return {
    kind: "env",
    url: env.RIKA_BACKEND_URL.replace(/\/$/, ""),
    token: env.RIKA_BACKEND_TOKEN ?? "",
  }
}

const modeFromEnv = (env: Record<string, string | undefined>): Config.Mode => {
  const value = env.RIKA_MODE
  if (value === "rush" || value === "smart" || value === "deep1" || value === "deep2" || value === "deep3") return value
  return "smart"
}
