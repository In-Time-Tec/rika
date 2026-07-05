import { Config, KeyedSemaphore, Settings, SynchronizedMap, Time } from "@rika/core"
import { Database, OrbStore } from "@rika/persistence"
import { Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SandboxClient from "./sandbox-client"

const defaultIdleTimeoutSeconds = 300
const refreshThrottleMillis = 30_000

export class OrbActivityError extends Schema.TaggedErrorClass<OrbActivityError>()("OrbActivityError", {
  message: Schema.String,
  operation: Schema.String,
  orb_id: Schema.optional(Ids.OrbId),
}) {}

export type RunError =
  | Config.ConfigError
  | Database.DatabaseError
  | OrbActivityError
  | OrbStore.OrbStoreError
  | SandboxClient.RunError

export interface Interface {
  readonly touch: (orbId: Ids.OrbId) => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/OrbActivity") {}

export const layer: Layer.Layer<
  Service,
  Config.ConfigError,
  Config.Service | OrbStore.Service | SandboxClient.Service | Time.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const settings = Option.getOrUndefined(yield* Effect.serviceOption(Settings.Service))
    const orbs = yield* OrbStore.Service
    const sandbox = yield* SandboxClient.Service
    const time = yield* Time.Service
    const timeoutMs = yield* resolveTimeoutMs(config, settings)
    const lastRefreshByOrb = yield* SynchronizedMap.make<Ids.OrbId, number>()
    const refreshLocks = yield* KeyedSemaphore.make<Ids.OrbId>()

    return Service.of({
      touch: Effect.fn("OrbActivity.touch")(function* (orbId: Ids.OrbId) {
        const record = yield* orbs.get(orbId)
        if (record === undefined) {
          return yield* new OrbActivityError({
            message: `Orb ${orbId} not found`,
            operation: "touch",
            orb_id: orbId,
          })
        }
        if (record.status !== "running") {
          return yield* new OrbActivityError({
            message: `Orb ${orbId} is ${record.status}`,
            operation: "touch",
            orb_id: orbId,
          })
        }
        if (record.sandbox_id === null) {
          return yield* new OrbActivityError({
            message: `Orb ${orbId} has no sandbox`,
            operation: "touch",
            orb_id: orbId,
          })
        }
        const sandboxId = record.sandbox_id
        yield* KeyedSemaphore.withPermit(
          refreshLocks,
          orbId,
          Effect.gen(function* () {
            const now = yield* time.nowMillis
            const previousRefresh = Option.getOrUndefined(yield* SynchronizedMap.get(lastRefreshByOrb, orbId))
            if (previousRefresh === undefined || now - previousRefresh >= refreshThrottleMillis) {
              yield* sandbox.setTimeout(sandboxId, timeoutMs)
              yield* SynchronizedMap.set(lastRefreshByOrb, orbId, now)
            }
          }),
        )
        yield* orbs.touch(orbId)
        return yield* Effect.void
      }),
    })
  }),
)

export const touch = Effect.fn("OrbActivity.touch.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.touch(orbId)
})

const resolveTimeoutMs = Effect.fn("OrbActivity.resolveTimeoutMs")(function* (
  config: Config.Interface,
  settings: Settings.Interface | undefined,
) {
  const configured = yield* config.requireEnv("RIKA_ORB_IDLE_TIMEOUT").pipe(Effect.option)
  if (Option.isNone(configured)) {
    if (settings !== undefined) {
      const snapshot = yield* settings.snapshot
      return snapshot.values.orb.idleTimeoutSeconds * 1_000
    }
    return defaultIdleTimeoutSeconds * 1_000
  }
  const seconds = Number(configured.value)
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return yield* new Config.ConfigError({
      message: `Invalid RIKA_ORB_IDLE_TIMEOUT ${configured.value}`,
      key: "RIKA_ORB_IDLE_TIMEOUT",
    })
  }
  return seconds * 1_000
})
