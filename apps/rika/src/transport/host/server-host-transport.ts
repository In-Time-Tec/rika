import * as ServerService from "@rika/product/server-service"
import { Config, Deferred, Effect, FileSystem } from "effect"
import { readOrCreateToken, resolve } from "../../server/process/server-endpoint"
import { releaseAdoptedStartup } from "../../server/process/server-startup"
import { defaultOutboundCapacity } from "../protocol/server-protocol"
import { host } from "./server-host-lifecycle"
import type { Owner } from "./server-host-operation"

export const serve = Effect.fn("ServerTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly abandonMilliseconds?: number
  readonly ownerDrainMilliseconds?: number
  readonly startupHoldMilliseconds?: number
  readonly outboundCapacity?: number
  readonly onReady?: Effect.Effect<void, ServerService.ServerServiceError, FileSystem.FileSystem>
  readonly owner: Owner
  readonly configWatchPaths?: ReadonlyArray<string>
  readonly configReloadDebounceMilliseconds?: number
  readonly configReloadDrainTimeoutMilliseconds?: number
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const ownerDrainMilliseconds =
    options.ownerDrainMilliseconds ??
    Number(yield* Config.string("RIKA_INTERNAL_SERVER_OWNER_DRAIN").pipe(Config.withDefault("5000")))
  const stopped = yield* Deferred.make<void>()
  const ready = yield* Deferred.make<void>()
  yield* Effect.forkChild(
    Deferred.await(ready).pipe(
      Effect.andThen(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)),
    ),
  )
  yield* host({
    ...endpoint,
    token,
    graceMilliseconds: options.graceMilliseconds ?? 500,
    abandonMilliseconds:
      options.abandonMilliseconds ??
      Number(yield* Config.string("RIKA_INTERNAL_SERVER_ABANDON").pipe(Config.withDefault("5000"))),
    ownerDrainMilliseconds,
    startupHoldMilliseconds: options.startupHoldMilliseconds ?? 10_000,
    outboundCapacity: Math.max(1, Math.floor(options.outboundCapacity ?? defaultOutboundCapacity)),
    stopped,
    ready,
    onReady: options.onReady ?? Effect.void,
    owner: options.owner,
    ...(options.configWatchPaths === undefined ? {} : { configWatchPaths: options.configWatchPaths }),
    ...(options.configReloadDebounceMilliseconds === undefined
      ? {}
      : { configReloadDebounceMilliseconds: options.configReloadDebounceMilliseconds }),
    ...(options.configReloadDrainTimeoutMilliseconds === undefined
      ? {}
      : { configReloadDrainTimeoutMilliseconds: options.configReloadDrainTimeoutMilliseconds }),
  }).pipe(Effect.ensuring(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)))
})
