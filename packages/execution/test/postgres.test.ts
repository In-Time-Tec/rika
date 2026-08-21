import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ExecutionHost, RunClaims, RunStore, RuntimeWorker } from "tenetkit/runtime"
import * as Postgres from "../src/postgres"

const worker = {
  workerId: "railway-worker-01",
  concurrency: 4,
  leaseMillis: 30_000,
  pollIntervalMillis: 200,
  cancellationIntervalMillis: 100,
} as const

const options = {
  url: "postgresql://runtime.invalid/tenetkit",
  source: "rika-tenetkit",
  maxConnections: 10,
  worker,
} as const

it.effect("validates the complete PostgreSQL and worker configuration", () =>
  Effect.gen(function* () {
    expect(yield* Postgres.validateOptions(options)).toEqual(options)
    expect(Postgres.toWorkerOptions(worker)).toEqual({
      workerId: "railway-worker-01",
      concurrency: 4,
      lease: 30_000,
      pollInterval: 200,
      cancellationInterval: 100,
    })
  }),
)

it.effect("rejects missing identities and non-positive PostgreSQL worker bounds before opening a database", () =>
  Effect.gen(function* () {
    const invalid = [
      { ...options, url: "" },
      { ...options, source: "" },
      { ...options, maxConnections: 0 },
      { ...options, worker: { ...worker, workerId: "" } },
      { ...options, worker: { ...worker, concurrency: 0 } },
      { ...options, worker: { ...worker, leaseMillis: 0 } },
      { ...options, worker: { ...worker, pollIntervalMillis: 0 } },
      { ...options, worker: { ...worker, cancellationIntervalMillis: 0 } },
    ]
    for (const candidate of invalid) {
      const exit = yield* Effect.exit(Postgres.validateOptions(candidate))
      expect(Exit.isFailure(exit)).toBe(true)
    }
  }),
)

const workerDependencies = (claims: RunClaims.Interface) =>
  Layer.mergeAll(
    Layer.succeed(RunClaims.RunClaims, RunClaims.RunClaims.of(claims)),
    Layer.succeed(
      ExecutionHost.ExecutionHost,
      ExecutionHost.ExecutionHost.of({ execute: () => Effect.void } as unknown as ExecutionHost.Interface),
    ),
    Layer.succeed(
      RunStore.RunStore,
      RunStore.RunStore.of({ inspect: () => Effect.die("unused") } as unknown as RunStore.Interface),
    ),
  )

const claims = (claimReadyRuns: RunClaims.Interface["claimReadyRuns"]): RunClaims.Interface => ({
  claimReadyRuns,
  refreshLease: () => Effect.succeed(true),
  releaseClaim: () => Effect.void,
  commitWithClaim: () => Effect.void,
})

it.effect("runs the RuntimeWorker loop only for its owning scope", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const ticks = yield* Ref.make(0)
    const dependencies = workerDependencies(
      claims(() =>
        Ref.update(ticks, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.as([]),
        ),
      ),
    )
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(Postgres.workerLayer(worker).pipe(Layer.provide(dependencies)), scope)
    const runtimeWorker = Context.get(context, RuntimeWorker.RuntimeWorker)
    const health = Context.get(context, Postgres.WorkerHealth)
    yield* Deferred.await(started)
    yield* Effect.yieldNow
    expect(runtimeWorker.workerId).toBe(worker.workerId)
    yield* health.check
    const beforeClose = yield* Ref.get(ticks)
    yield* Scope.close(scope, Exit.void)
    yield* TestClock.adjust("1 second")
    expect(yield* Ref.get(ticks)).toBe(beforeClose)
  }),
)

it.effect("reports a worker defect and keeps the supervised loop running", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>()
    const attempts = yield* Ref.make(0)
    const dependencies = workerDependencies(
      claims(() =>
        Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.die("worker defect")))
              : Effect.succeed([]),
          ),
        ),
      ),
    )
    const context = yield* Layer.build(Postgres.workerLayer(worker).pipe(Layer.provide(dependencies)))
    const health = Context.get(context, Postgres.WorkerHealth)
    yield* Deferred.await(attempted)
    yield* Effect.yieldNow
    const unavailable = yield* health.check.pipe(Effect.flip)
    expect(unavailable.message).toBe("Hosted execution worker is unavailable")
    yield* TestClock.adjust(worker.pollIntervalMillis)
    yield* health.check
    expect(yield* Ref.get(attempts)).toBeGreaterThanOrEqual(2)
  }).pipe(Effect.scoped),
)
