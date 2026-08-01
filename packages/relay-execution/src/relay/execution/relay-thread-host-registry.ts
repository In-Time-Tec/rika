import { Context, Effect, Option, Ref } from "effect"

export type Promoter = (threadId: string, generation: number) => Effect.Effect<number>

export interface RegistryInterface {
  readonly register: (promoter: Promoter) => Effect.Effect<void>
  readonly promote: (threadId: string, generation: number) => Effect.Effect<number>
}

export class Registry extends Context.Service<Registry, RegistryInterface>()(
  "@rika/relay-execution/relay/execution/relay-thread-host-registry/Registry",
) {}

export const makeRegistry: Effect.Effect<RegistryInterface> = Effect.gen(function* () {
  const slot = yield* Ref.make(Option.none<Promoter>())
  return Registry.of({
    register: (promoter) => Ref.set(slot, Option.some(promoter)),
    promote: (threadId, generation) =>
      Ref.get(slot).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(0),
            onSome: (promoter) => promoter(threadId, generation),
          }),
        ),
      ),
  })
})
