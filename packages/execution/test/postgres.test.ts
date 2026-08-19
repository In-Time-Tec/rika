import { expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer } from "effect"
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

it.effect("composes the released RuntimeWorker loop without giving an executor storage services", () =>
  Effect.gen(function* () {
    const claims = RunClaims.RunClaims.of({
      claimReadyRuns: () => Effect.succeed([]),
      refreshLease: () => Effect.succeed(true),
      releaseClaim: () => Effect.void,
      commitWithClaim: () => Effect.void,
    })
    const dependencies = Layer.mergeAll(
      Layer.succeed(RunClaims.RunClaims, claims),
      Layer.succeed(
        ExecutionHost.ExecutionHost,
        ExecutionHost.ExecutionHost.of({ execute: () => Effect.void } as unknown as ExecutionHost.Interface),
      ),
      Layer.succeed(
        RunStore.RunStore,
        RunStore.RunStore.of({ inspect: () => Effect.die("unused") } as unknown as RunStore.Interface),
      ),
    )
    const context = yield* Layer.build(Postgres.workerLayer(worker).pipe(Layer.provide(dependencies)))
    const runtimeWorker = Context.get(context, RuntimeWorker.RuntimeWorker)
    expect(runtimeWorker.workerId).toBe(worker.workerId)
    expect(yield* runtimeWorker.tick).toEqual([])
  }).pipe(Effect.scoped),
)
