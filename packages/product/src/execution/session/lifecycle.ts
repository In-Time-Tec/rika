import { Context, Effect, Layer, Schema } from "effect"

export class Unavailable extends Schema.TaggedError<Unavailable>()("ExecutionSessionLifecycleUnavailable", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly requestCancellation: (input: {
    readonly sessionId: string
    readonly reason?: string
  }) => Effect.Effect<void, Unavailable>
  readonly awaitTerminal: (input: { readonly sessionId: string }) => Effect.Effect<void, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/execution/session/lifecycle/Service",
) {}

export const layerTest = (overrides: Partial<Interface> = {}) =>
  Layer.succeed(
    Service,
    Service.of({
      requestCancellation: () => Effect.void,
      awaitTerminal: () => Effect.void,
      ...overrides,
    }),
  )
