import { RunSchema, layerPostgres as upstreamLayer } from "@tenetkit/pg"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  Errors,
  ExecutableResolver,
  ExecutionHost,
  RunClaims,
  RunStore,
  Runtime,
  RuntimeWorker,
} from "tenetkit/runtime"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export type SchemaError =
  | Errors.SchemaChecksumMismatch
  | Errors.SchemaDirty
  | Errors.SchemaMigrationFailed
  | Errors.SchemaUpgradeRequired
  | Errors.SchemaVersionUnsupported
  | SqlError

export const WorkerOptions = Schema.Struct({
  workerId: NonEmptyString,
  concurrency: PositiveInt,
  leaseMillis: PositiveInt,
  pollIntervalMillis: PositiveInt,
  cancellationIntervalMillis: PositiveInt,
})

export type WorkerOptions = typeof WorkerOptions.Type

export const Options = Schema.Struct({
  url: NonEmptyString,
  source: NonEmptyString,
  maxConnections: PositiveInt,
  worker: WorkerOptions,
})

export type Options = typeof Options.Type

export class InvalidOptions extends Schema.TaggedError<InvalidOptions>()(
  "@rika/execution/postgres/InvalidOptions",
  { message: Schema.String },
) {}

export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()(
  "@rika/execution/postgres/RuntimeUnavailable",
  { message: Schema.String },
) {}

export const ReadinessProof = Schema.Struct({
  backend: Schema.Literal("postgres"),
  source: NonEmptyString,
  workerId: NonEmptyString,
})

export type ReadinessProof = typeof ReadinessProof.Type

export interface ReadinessInterface {
  readonly check: Effect.Effect<ReadinessProof, SchemaError>
}

export class Readiness extends Context.Service<Readiness, ReadinessInterface>()("@rika/execution/postgres/Readiness") {}

const invalidOptions = () => InvalidOptions.make({ message: "PostgreSQL API options are invalid" })

export const validateOptions = Effect.fn("Postgres.validateOptions")(function* (input: unknown) {
  return yield* Schema.decodeUnknownEffect(Options, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(invalidOptions),
  )
})

export const validateWorkerOptions = Effect.fn("Postgres.validateWorkerOptions")(function* (
  input: unknown,
) {
  return yield* Schema.decodeUnknownEffect(WorkerOptions, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(invalidOptions),
  )
})

export const toWorkerOptions = (options: WorkerOptions): RuntimeWorker.WorkerOptions => ({
  workerId: options.workerId,
  concurrency: options.concurrency,
  lease: options.leaseMillis,
  pollInterval: options.pollIntervalMillis,
  cancellationInterval: options.cancellationIntervalMillis,
})

export const applySchema = Effect.fn("Postgres.applySchema")(function* (
  input: Pick<Options, "url" | "source">,
) {
  return yield* Effect.scoped(
    Layer.build(RunSchema.layerClient(input.url)).pipe(
      Effect.flatMap((context) => RunSchema.apply(input.source).pipe(Effect.provide(context))),
    ),
  ) as Effect.Effect<undefined, SchemaError>
})

export const checkSchema = Effect.fn("Postgres.checkSchema")(function* (
  input: Pick<Options, "url" | "source">,
) {
  return yield* Effect.scoped(
    Layer.build(RunSchema.layerClient(input.url)).pipe(
      Effect.flatMap((context) => RunSchema.check(input.source).pipe(Effect.provide(context))),
    ),
  ) as Effect.Effect<undefined, SchemaError>
})

export const workerLayer = (
  options: WorkerOptions,
): Layer.Layer<
  RuntimeWorker.RuntimeWorker,
  InvalidOptions,
  RunClaims.RunClaims | ExecutionHost.ExecutionHost | RunStore.RunStore
> =>
  Layer.unwrap(
    validateWorkerOptions(options).pipe(
      Effect.map((validated) => RuntimeWorker.layerWorkerLoop(toWorkerOptions(validated))),
    ),
  )

export interface LayerOptions {
  readonly postgres: Options
  readonly resolver: ExecutableResolver.Interface
  readonly subscriberQueueCapacity?: number
  readonly scheduler?: Runtime.LayerOptions["scheduler"]
}

const runtimeUnavailable = (cause: Cause.Cause<unknown>) =>
  RuntimeUnavailable.make({ message: String(Cause.squash(cause)) })

export const layer = (
  options: LayerOptions,
): Layer.Layer<
  | Readiness
  | Runtime.Runtime
  | RuntimeWorker.RuntimeWorker
  | RunStore.RunStore
  | RunClaims.RunClaims
  | ExecutionHost.ExecutionHost,
  InvalidOptions | RuntimeUnavailable
> =>
  Layer.unwrap(
    validateOptions(options.postgres).pipe(
      Effect.map((postgres) => {
        const postgresLayerOptions = {
          url: postgres.url,
          source: postgres.source,
          maxConnections: postgres.maxConnections,
          resolver: options.resolver,
          addresses: [],
          ...(options.subscriberQueueCapacity === undefined
            ? {}
            : { subscriberQueueCapacity: options.subscriberQueueCapacity }),
          ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
        }
        const runtime = upstreamLayer(postgresLayerOptions).pipe(
          Layer.catchCause((cause) => Layer.effectContext(Effect.fail(runtimeUnavailable(cause)))),
        )
        const worker = workerLayer(postgres.worker).pipe(Layer.provideMerge(runtime))
        const readiness = Layer.effect(
          Readiness,
          Effect.gen(function* () {
            const runtimeWorker = yield* RuntimeWorker.RuntimeWorker
            return Readiness.of({
              check: checkSchema(postgres).pipe(
                Effect.andThen(runtimeWorker.claimed),
                Effect.as(
                  ReadinessProof.make({
                    backend: "postgres",
                    source: postgres.source,
                    workerId: runtimeWorker.workerId,
                  }),
                ),
              ),
            })
          }),
        )
        return readiness.pipe(Layer.provideMerge(worker))
      }),
    ),
  )
