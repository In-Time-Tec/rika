import { Effect, Schema } from "effect"

/**
 * Presentation rows (thread protocol snapshots and events, transcript units) are derived from
 * Generalist's durable Run log. A row the current contract cannot decode is therefore a stale
 * cache, not authority: dropping it keeps the Thread readable and lets the projection rebuild,
 * while failing would wedge every replay of that Thread forever.
 */
export const decodeDerivedRow = <S extends Schema.Top>(input: {
  readonly schema: S
  readonly event: string
  readonly value: unknown
  readonly annotations: ReadonlyArray<readonly [string, string]>
}): Effect.Effect<S["Type"] | undefined, never, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(input.schema)(input.value).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(input.event).pipe(
        Effect.annotateLogs(Object.fromEntries([...input.annotations, ["rika.error.message", String(cause)]])),
        Effect.as(undefined),
      ),
    ),
  )
