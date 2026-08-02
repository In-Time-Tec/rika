import { Effect } from "effect"
import { threadIdFromMetadata } from "./relay-execution-identifier"

export const traceWithoutResult = <A, E, R>(input: {
  readonly name: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let result!: A
    return input.effect.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          result = value
        }),
      ),
      Effect.asVoid,
      Effect.withSpan(input.name),
      Effect.andThen(Effect.sync(() => result)),
    )
  })

export const threadId = threadIdFromMetadata
