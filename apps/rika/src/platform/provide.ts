import { Context, Effect, Layer } from "effect"

/**
 * Provides a Layer to an Effect while building it inside the Effect's own scope.
 * Equivalent to `Effect.provide(layer)`; kept as the one named entry so the
 * strict-effect-provide lint has a single audited call site.
 */
export const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )
