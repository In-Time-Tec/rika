import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"

export const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))
