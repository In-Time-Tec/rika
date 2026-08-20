import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Data, Effect, FileSystem, Function, Layer, Schema, Scope } from "effect"

export type Event = {
  type: string
  role?: string | undefined
  id?: string | undefined
  clientPid?: number | undefined
  hostPid?: number | undefined
  text?: string | undefined
  tag?: string | undefined
  status?: string | undefined
  error?: string | undefined
  callbacks?: number | undefined
  tags?: ReadonlyArray<string> | undefined
  outcome?: string | undefined
  revision?: number | undefined
  runId?: string | undefined
}

export class FixtureFailure extends Data.TaggedError("FixtureFailure")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export const provide: {
  <A, E, R, ROut, E2, RIn>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, Exclude<RIn | Exclude<R, ROut>, Scope.Scope>>
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, Exclude<RIn | Exclude<R, ROut>, Scope.Scope>>
} = Function.dual(
  2,
  <A, E, R, ROut, E2, RIn>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, Exclude<RIn | Exclude<R, ROut>, Scope.Scope>> =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.provide(effect, context)
      }),
    ),
)

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

export const EventSchema = Schema.Struct({
  type: Schema.String,
  role: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  clientPid: Schema.optional(Schema.Finite),
  hostPid: Schema.optional(Schema.Finite),
  text: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  callbacks: Schema.optional(Schema.Finite),
  tags: Schema.optional(Schema.Array(Schema.String)),
  outcome: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Finite),
  runId: Schema.optional(Schema.String),
})

const decodeEventLine = Schema.decodeUnknownEffect(Schema.fromJsonString(EventSchema))
export const decodeEvent = (input: unknown) => decodeEventLine(input)

export const waitUntil: {
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout?: number): Effect.Effect<undefined, E, R>
  (timeout?: number): <E, R>(condition: Effect.Effect<boolean, E, R>) => Effect.Effect<undefined, E, R>
} = Function.dual(
  (args) => Effect.isEffect(args[0]),
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 2_000): Effect.Effect<undefined, E, R> =>
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      while (!(yield* condition)) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= timeout) return yield* Effect.die("condition timed out")
        yield* Effect.sleep("20 millis")
      }
    }),
)

export const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  return yield* fileSystem.makeTempDirectory({ directory: temporaryDirectory, prefix: "rika-server-" })
})
