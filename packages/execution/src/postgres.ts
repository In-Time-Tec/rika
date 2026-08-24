import { RunSchema, layerPostgres as upstreamLayer } from "@tenetkit/pg"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Cause, Clock, Context, Effect, Function, Layer, Schema, Scope } from "effect"
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

export class InvalidOptions extends Schema.TaggedError<InvalidOptions>()("@rika/execution/postgres/InvalidOptions", {
  message: Schema.String,
}) {}

export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()(
  "@rika/execution/postgres/RuntimeUnavailable",
  { message: Schema.String },
) {}

export class WorkerUnavailable extends Schema.TaggedError<WorkerUnavailable>()(
  "@rika/execution/postgres/WorkerUnavailable",
  { message: Schema.String },
) {}

export const ReadinessProof = Schema.Struct({
  backend: Schema.Literal("postgres"),
  source: NonEmptyString,
  workerId: NonEmptyString,
})

export type ReadinessProof = typeof ReadinessProof.Type

export interface WorkerDiagnostics extends RuntimeWorker.WorkerStatus {
  readonly pollAgeMillis: number | undefined
  readonly lastSuccessfulPollAgeMillis: number | undefined
  readonly oldestClaimAgeMillis: number | undefined
  readonly lastFailureAgeMillis: number | undefined
  readonly availableCapacity: number
}

export interface ReadinessInterface {
  readonly check: Effect.Effect<ReadinessProof, SchemaError | WorkerUnavailable>
  readonly status: Effect.Effect<WorkerDiagnostics>
}

export class Readiness extends Context.Service<Readiness, ReadinessInterface>()("@rika/execution/postgres/Readiness") {}

const invalidOptions = () => InvalidOptions.make({ message: "PostgreSQL API options are invalid" })

export const validateOptions = Effect.fn("Postgres.validateOptions")(function* (input: unknown) {
  return yield* Schema.decodeUnknownEffect(Options, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(invalidOptions),
  )
})

export const validateWorkerOptions = Effect.fn("Postgres.validateWorkerOptions")(function* (input: unknown) {
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
  onClaim: observeClaim,
})

export const observeClaim = (claim: {
  readonly run: {
    readonly runId: string
    readonly message?: { readonly metadata?: Readonly<Record<string, unknown>> }
  }
}) => {
  const metadata: Readonly<Record<string, unknown>> = claim.run.message?.metadata ?? {}
  return HostedObservability.event("run_claim", "success", {
    runId: claim.run.runId,
    ...(typeof metadata.threadId === "string" ? { threadId: metadata.threadId } : {}),
    ...(typeof metadata.turnId === "string" ? { turnId: metadata.turnId } : {}),
  })
}

export const applySchema = Effect.fn("Postgres.applySchema")(function* (input: Pick<Options, "url" | "source">) {
  return yield* Effect.scoped(
    Layer.build(RunSchema.layerClient(input.url)).pipe(
      Effect.flatMap((context) => RunSchema.apply(input.source).pipe(Effect.provide(context))),
    ),
  ) as Effect.Effect<undefined, SchemaError>
})

export const checkSchema = Effect.fn("Postgres.checkSchema")(function* (input: Pick<Options, "url" | "source">) {
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
      Effect.map((validated) => {
        const worker: Layer.Layer<
          RuntimeWorker.RuntimeWorker,
          never,
          RunClaims.RunClaims | ExecutionHost.ExecutionHost | RunStore.RunStore
        > = RuntimeWorker.layerWorker(toWorkerOptions(validated))
        const runLoop: Effect.Effect<void, never, RuntimeWorker.RuntimeWorker | Scope.Scope> = Effect.gen(function* () {
          const runtimeWorker = yield* RuntimeWorker.RuntimeWorker
          yield* Effect.forkScoped(runtimeWorker.run)
        })
        const loop: Layer.Layer<
          never,
          never,
          RunClaims.RunClaims | ExecutionHost.ExecutionHost | RunStore.RunStore
        > = Layer.effectDiscard(runLoop).pipe(Layer.provide(worker))
        return Layer.merge(worker, loop)
      }),
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

const age = (now: number, at: number | undefined) => (at === undefined ? undefined : now - at)

export const workerDiagnostics: {
  (now: number): (status: RuntimeWorker.WorkerStatus) => WorkerDiagnostics
  (status: RuntimeWorker.WorkerStatus, now: number): WorkerDiagnostics
} = Function.dual(2, (status: RuntimeWorker.WorkerStatus, now: number): WorkerDiagnostics => ({
  ...status,
  pollAgeMillis: status.poll._tag === "Starting" ? undefined : age(now, status.poll.at),
  lastSuccessfulPollAgeMillis: age(now, status.lastSuccessfulPollAt),
  oldestClaimAgeMillis: age(now, status.oldestClaimAt),
  lastFailureAgeMillis: age(now, status.lastFailure?.at),
  availableCapacity: Math.max(0, status.capacity - status.active),
}))

export const checkWorkerReadiness: {
  (now: number, pollIntervalMillis: number): (status: RuntimeWorker.WorkerStatus) => Effect.Effect<void, WorkerUnavailable>
  (
    status: RuntimeWorker.WorkerStatus,
    now: number,
    pollIntervalMillis: number,
  ): Effect.Effect<void, WorkerUnavailable>
} = Function.dual(
  3,
  (
    status: RuntimeWorker.WorkerStatus,
    now: number,
    pollIntervalMillis: number,
  ): Effect.Effect<void, WorkerUnavailable> => {
    if (status.poll._tag === "Starting")
      return Effect.fail(WorkerUnavailable.make({ message: "Hosted execution worker has not completed its first poll" }))
    if (status.poll._tag === "Failed")
      return Effect.fail(WorkerUnavailable.make({ message: "Hosted execution worker poll failed" }))
    if (now - status.poll.at > pollIntervalMillis * 4)
      return Effect.fail(WorkerUnavailable.make({ message: "Hosted execution worker poll is stale" }))
    return Effect.void
  },
)

export const makeReadiness = (input: {
  readonly source: string
  readonly pollIntervalMillis: number
  readonly worker: Pick<RuntimeWorker.Interface, "workerId" | "status">
  readonly schema: Effect.Effect<void, SchemaError>
}): ReadinessInterface => {
  const status: Effect.Effect<RuntimeWorker.WorkerStatus> = input.worker.status
  const check: Effect.Effect<ReadinessProof, SchemaError | WorkerUnavailable> = Effect.gen(function* () {
    yield* input.schema
    const workerStatus = yield* status
    const now = yield* Clock.currentTimeMillis
    yield* checkWorkerReadiness(workerStatus, now, input.pollIntervalMillis)
    return ReadinessProof.make({ backend: "postgres", source: input.source, workerId: input.worker.workerId })
  })
  const diagnostics: Effect.Effect<WorkerDiagnostics> = Effect.all([status, Clock.currentTimeMillis]).pipe(
    Effect.map(([workerStatus, now]) => workerDiagnostics(workerStatus, now)),
  )
  return {
    check,
    status: diagnostics,
  }
}

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
            return Readiness.of(
              makeReadiness({
                source: postgres.source,
                pollIntervalMillis: postgres.worker.pollIntervalMillis,
                worker: runtimeWorker,
                schema: checkSchema(postgres),
              }),
            )
          }),
        )
        return readiness.pipe(Layer.provideMerge(worker))
      }),
    ),
  )
