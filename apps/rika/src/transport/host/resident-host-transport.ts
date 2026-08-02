import * as ResidentService from "@rika/product/resident-service"
import { Config, Deferred, Effect, FileSystem } from "effect"
import { readOrCreateToken, resolve } from "../../resident/process/resident-endpoint"
import { releaseAdoptedStartup } from "../../resident/process/resident-startup"
import { defaultOutboundCapacity } from "../protocol/resident-protocol"
import { host } from "./resident-host-lifecycle"
import type { Owner } from "./resident-host-operation"

export const serve = Effect.fn("ResidentTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly abandonMilliseconds?: number
  readonly ownerDrainMilliseconds?: number
  readonly startupHoldMilliseconds?: number
  readonly outboundCapacity?: number
  readonly onReady?: Effect.Effect<void, ResidentService.ResidentServiceError, FileSystem.FileSystem>
  readonly owner: Owner
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const ownerDrainMilliseconds =
    options.ownerDrainMilliseconds ??
    Number(yield* Config.string("RIKA_INTERNAL_RESIDENT_OWNER_DRAIN").pipe(Config.withDefault("5000")))
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
      Number(yield* Config.string("RIKA_INTERNAL_RESIDENT_ABANDON").pipe(Config.withDefault("5000"))),
    ownerDrainMilliseconds,
    startupHoldMilliseconds: options.startupHoldMilliseconds ?? 10_000,
    outboundCapacity: Math.max(1, Math.floor(options.outboundCapacity ?? defaultOutboundCapacity)),
    stopped,
    ready,
    onReady: options.onReady ?? Effect.void,
    owner: options.owner,
  }).pipe(Effect.ensuring(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)))
})
