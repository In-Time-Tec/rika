import { Context, Effect, Layer } from "effect"
import { Common } from "@rika/schema"

export interface Interface {
  readonly nowMillis: Effect.Effect<Common.TimestampMillis>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/Time") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    nowMillis: Effect.sync(() => Common.TimestampMillis.make(Date.now())),
  }),
)

export const fixedLayer = (now: Common.TimestampMillis) =>
  Layer.succeed(Service, Service.of({ nowMillis: Effect.succeed(now) }))

export const nowMillis = Effect.fn("Time.nowMillis")(function* () {
  const time = yield* Service
  return yield* time.nowMillis
})
