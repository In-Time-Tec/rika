import { Effect, Function, Layer, Scope } from "effect"

export const provide: {
  <R, E2, RIn>(
    layer: Layer.Layer<R, E2, RIn>,
  ): <A, E, RAll>(effect: Effect.Effect<A, E, RAll>) => Effect.Effect<A, E | E2, RIn | Exclude<RAll, R> | Scope.Scope>
  <A, E, RAll, R, E2, RIn>(
    effect: Effect.Effect<A, E, RAll>,
    layer: Layer.Layer<R, E2, RIn>,
  ): Effect.Effect<A, E | E2, RIn | Exclude<RAll, R> | Scope.Scope>
} = Function.dual(2, <A, E, RAll, R, E2, RIn>(effect: Effect.Effect<A, E, RAll>, layer: Layer.Layer<R, E2, RIn>) =>
  Layer.build(layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
)
