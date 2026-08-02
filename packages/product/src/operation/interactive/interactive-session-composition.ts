import { Effect, Fiber, Scope, Semaphore } from "effect"
import { OperationUnavailable } from "../contract/product-operation"

export const makeInteractiveSessionComposition = (input: {
  readonly admission: Semaphore.Semaphore
  readonly scope: Scope.Scope
  readonly closed: OperationUnavailable
  readonly isOpen: () => boolean
  readonly isAttached: () => boolean
  readonly setAttached: (attached: boolean) => void
}) => {
  const admit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
    input.admission
      .withPermits(1)(Effect.suspend(() => (input.isOpen() ? Effect.succeed(effect) : Effect.fail(input.closed))))
      .pipe(Effect.flatten)
  const runOwned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.forkIn(effect, input.scope).pipe(
      Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))),
    )
  const admitLocal = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
    effect.pipe(runOwned, admit)
  const attachFeed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
    input.admission
      .withPermits(1)(
        Effect.suspend(() => {
          if (!input.isOpen()) return Effect.fail(input.closed)
          if (input.isAttached())
            return Effect.fail(
              OperationUnavailable.make({
                operation: "InteractiveSession.events",
                message: "Interactive session already has an event consumer",
              }),
            )
          input.setAttached(true)
          return Effect.succeed(runOwned(effect.pipe(Effect.ensuring(Effect.sync(() => input.setAttached(false))))))
        }),
      )
      .pipe(Effect.flatten)
  return { admit, admitLocal, attachFeed, runOwned }
}
