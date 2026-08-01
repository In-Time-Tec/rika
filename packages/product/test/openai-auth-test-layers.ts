import { Context, Effect, Function, Layer, Option, Semaphore } from "effect"
import { deterministicCrypto } from "./openai-auth-test-credentials"
import { Host, Http, Presenter, Store } from "./openai-auth-test-contract"
import { layer } from "./openai-auth-test-service"

type Disk = import("../src/authentication/openai-auth-contract").CredentialDisk.Type

export const memoryStore = (initial: Option.Option<Disk> = Option.none()) => {
  let value = initial
  let serialized = 0
  return {
    layer: Layer.effect(
      Store,
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        return Store.of({
          load: Effect.sync(() => value),
          save: (next) =>
            Effect.sync(() => {
              value = Option.some(next)
            }),
          remove: Effect.sync(() => {
            const removed = Option.isSome(value)
            value = Option.none()
            return removed
          }),
          serialized: (effect) =>
            semaphore.withPermits(1)(
              Effect.sync(() => {
                serialized++
              }).pipe(Effect.andThen(effect)),
            ),
        })
      }),
    ),
    value: () => value,
    serialized: () => serialized,
  }
}

const dependenciesImpl = (
  store: Layer.Layer<Store>,
  http: Http["Service"],
  host?: Host["Service"],
  presenter?: Presenter["Service"],
) =>
  layer({ deviceTimeout: 5_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        store,
        deterministicCrypto(),
        Layer.succeed(Http, http),
        Layer.succeed(Host, host ?? Host.of({ authorize: () => Effect.die("unused") })),
        Layer.succeed(Presenter, presenter ?? Presenter.of({ device: () => Effect.void })),
      ),
    ),
  )

export const dependencies: {
  (
    http: Http["Service"],
    host?: Host["Service"],
    presenter?: Presenter["Service"],
  ): (store: Layer.Layer<Store>) => ReturnType<typeof dependenciesImpl>
  (
    store: Layer.Layer<Store>,
    http: Http["Service"],
    host?: Host["Service"],
    presenter?: Presenter["Service"],
  ): ReturnType<typeof dependenciesImpl>
} = Function.dual((args) => args.length >= 2, dependenciesImpl)

export const provideLayer: {
  <AOut, EOut, RIn>(
    provided: Layer.Layer<AOut, EOut, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | EOut, RIn | Exclude<R, AOut>>
  <A, E, R, AOut, EOut, RIn>(
    effect: Effect.Effect<A, E, R>,
    provided: Layer.Layer<AOut, EOut, RIn>,
  ): Effect.Effect<A, E | EOut, RIn | Exclude<R, AOut>>
} = Function.dual(
  2,
  <A, E, R, AOut, EOut, RIn>(effect: Effect.Effect<A, E, R>, provided: Layer.Layer<AOut, EOut, RIn>) =>
    Effect.scoped(
      Layer.build(provided).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provide(context as unknown as Context.Context<R>))),
      ),
    ),
)

export const unusedHttp = Http.of({
  exchange: () => Effect.die("unused"),
  refresh: () => Effect.die("unused"),
  deviceStart: Effect.die("unused"),
  devicePoll: () => Effect.die("unused"),
})
