import { expect, it } from "@effect/vitest"
import { Context, DateTime, Deferred, Effect, Exit, Layer, Logger, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import {
  Address,
  ExecutableManifest,
  ExecutionHost,
  Message,
  RunClaims,
  RunStore,
  RuntimeWorker,
  TreePolicy,
} from "tenetkit/runtime"
import { Prompt } from "effect/unstable/ai"
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
      onClaim: Postgres.observeClaim,
    })
  }),
)

it.effect("emits persisted Thread, Turn, and Run correlation when a Run claim is accepted", () => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.map(Logger.formatStructured, (record) => logs.push(record))
  const claim = {
    run: {
      runId: "run-claim-01",
      message: { metadata: { threadId: "thread-claim-01", turnId: "turn-claim-01", ignored: 42 } },
    },
  } satisfies Parameters<typeof Postgres.observeClaim>[0]

  return Postgres.observeClaim(claim).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(logs).toContainEqual(
          expect.objectContaining({
            message: "hosted.run_claim.success",
            annotations: expect.objectContaining({
              "rika.thread.id": "thread-claim-01",
              "rika.turn.id": "turn-claim-01",
              "rika.run.id": "run-claim-01",
              "rika.hosted.stage": "run_claim",
            }),
          }),
        )
      }),
    ),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
  )
})

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

const workerDependencies = (
  claims: RunClaims.Interface,
  executionHost: ExecutionHost.Interface = {
    execute: () => Effect.void,
    interrupt: () => Effect.void,
  },
) =>
  Layer.mergeAll(
    Layer.succeed(RunClaims.RunClaims, RunClaims.RunClaims.of(claims)),
    Layer.succeed(ExecutionHost.ExecutionHost, ExecutionHost.ExecutionHost.of(executionHost)),
    RunStore.layerMemory({ addresses: [], resolver: { resolve: () => Effect.die("unused") } }),
  )

const claims = (claimReadyRuns: RunClaims.Interface["claimReadyRuns"]): RunClaims.Interface => ({
  claimReadyRuns,
  refreshLease: () => Effect.succeed(true),
  releaseClaim: () => Effect.void,
  commitWithClaim: () => Effect.void,
})

const waitUntil = (condition: Effect.Effect<boolean>): Effect.Effect<void> =>
  condition.pipe(
    Effect.flatMap((ready) => (ready ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(waitUntil(condition))))),
  )

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
    const workerLayer: Layer.Layer<RuntimeWorker.RuntimeWorker, Postgres.InvalidOptions> = Postgres.workerLayer(
      worker,
    ).pipe(Layer.provide(dependencies))
    const context = yield* Layer.buildWithScope(workerLayer, scope)
    const runtimeWorker = Context.get(context, RuntimeWorker.RuntimeWorker)
    yield* Deferred.await(started)
    yield* Effect.yieldNow
    expect(runtimeWorker.workerId).toBe(worker.workerId)
    expect((yield* runtimeWorker.status).poll._tag).toBe("Succeeded")
    const beforeClose = yield* Ref.get(ticks)
    yield* Scope.close(scope, Exit.void)
    yield* TestClock.adjust("1 second")
    expect(yield* Ref.get(ticks)).toBe(beforeClose)
  }),
)

it.effect("interrupts an active claim and clears its status when the worker scope closes", () =>
  Effect.gen(function* () {
    const executing = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const claimed = yield* Ref.make(false)
    const executable = ExecutableManifest.makeTest("scope-close", "1")
    const claim: Effect.Success<ReturnType<RunClaims.Interface["claimReadyRuns"]>>[number] = {
      run: {
        runId: "run-active-scope-close",
        status: "running",
        address: "agent:scope-close",
        sessionId: "session-scope-close",
        message: Message.make({
          id: "message-scope-close",
          to: Address.make("agent:scope-close"),
          sessionId: "session-scope-close",
          prompt: Prompt.make("work"),
          idempotencyKey: "scope-close",
          correlationId: "scope-close",
        }),
        messageDigest: "scope-close",
        executableRef: executable.ref,
        executableManifest: executable.manifest,
        rootRunId: "run-active-scope-close",
        depth: 0,
        treePolicy: TreePolicy.defaultTreePolicy,
        attempt: 1,
        attemptFence: 1,
        lastSequence: 0,
        cancellationRequested: false,
        acceptedSequence: 0,
        respondedWaitIds: new Set(),
        admittedAt: "2026-01-01T00:00:00.000Z",
      },
      workerId: worker.workerId,
      attemptFence: 1,
      leaseExpiresAt: DateTime.toDate(DateTime.makeUnsafe("2999-01-01T00:00:00.000Z")),
    }
    const dependencies = workerDependencies(
      claims(() => Ref.getAndSet(claimed, true).pipe(Effect.map((alreadyClaimed) => (alreadyClaimed ? [] : [claim])))),
      {
        execute: () =>
          Deferred.succeed(executing, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        interrupt: () => Effect.void,
      },
    )
    const scope = yield* Scope.make()
    const workerLayer: Layer.Layer<RuntimeWorker.RuntimeWorker, Postgres.InvalidOptions> = Postgres.workerLayer(
      worker,
    ).pipe(Layer.provide(dependencies))
    const context = yield* Layer.buildWithScope(workerLayer, scope)
    const runtimeWorker = Context.get(context, RuntimeWorker.RuntimeWorker)

    yield* Deferred.await(executing)
    yield* waitUntil(runtimeWorker.status.pipe(Effect.map((status) => status.active === 1)))
    yield* Scope.close(scope, Exit.void)

    expect(yield* Deferred.isDone(interrupted)).toBe(true)
    expect((yield* runtimeWorker.status).active).toBe(0)
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
    const workerLayer: Layer.Layer<RuntimeWorker.RuntimeWorker, Postgres.InvalidOptions> = Postgres.workerLayer(
      worker,
    ).pipe(Layer.provide(dependencies))
    const context = yield* Layer.build(workerLayer)
    const runtimeWorker = Context.get(context, RuntimeWorker.RuntimeWorker)
    yield* Deferred.await(attempted)
    yield* Effect.yieldNow
    expect((yield* runtimeWorker.status).poll._tag).toBe("Failed")
    yield* TestClock.adjust(worker.pollIntervalMillis)
    expect((yield* runtimeWorker.status).poll._tag).toBe("Succeeded")
    expect(yield* Ref.get(attempts)).toBeGreaterThanOrEqual(2)
  }).pipe(Effect.scoped),
)

const workerStatus = (
  poll: RuntimeWorker.WorkerStatus["poll"],
  overrides: Partial<RuntimeWorker.WorkerStatus> = {},
): RuntimeWorker.WorkerStatus => ({
  poll,
  lastSuccessfulPollAt: poll._tag === "Succeeded" ? poll.at : undefined,
  lastFailure: undefined,
  active: 0,
  capacity: 4,
  oldestClaimAt: undefined,
  ...overrides,
})

const readinessWorker = (status: Ref.Ref<RuntimeWorker.WorkerStatus>) => ({
  workerId: worker.workerId,
  status: Ref.get(status),
})

it.effect("uses only the current poll result and exact freshness fence for readiness", () =>
  Effect.gen(function* () {
    const now = 10_000
    const interval = worker.pollIntervalMillis
    const starting = yield* Effect.exit(
      Postgres.checkWorkerReadiness(workerStatus({ _tag: "Starting" }), now, interval),
    )
    expect(starting._tag).toBe("Failure")

    const failed = workerStatus(
      { _tag: "Failed", at: now, message: "latest poll failed" },
      { lastSuccessfulPollAt: now - 1 },
    )
    expect((yield* Effect.exit(Postgres.checkWorkerReadiness(failed, now, interval)))._tag).toBe("Failure")

    const fence = workerStatus({ _tag: "Succeeded", at: now - interval * 4 })
    yield* Postgres.checkWorkerReadiness(fence, now, interval)
    const stale = workerStatus({ _tag: "Succeeded", at: now - interval * 4 - 1 })
    expect((yield* Effect.exit(Postgres.checkWorkerReadiness(stale, now, interval)))._tag).toBe("Failure")
  }),
)

it.effect("returns exact proof after recovery and exposes non-gating worker diagnostics", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000)
    const retainedFailure = { at: 8_000, message: "earlier failure" }
    const status = yield* Ref.make(
      workerStatus(
        { _tag: "Failed", at: 9_900, message: "poll failed" },
        { lastSuccessfulPollAt: 9_800, lastFailure: retainedFailure },
      ),
    )
    const readiness = Postgres.makeReadiness({
      source: options.source,
      pollIntervalMillis: worker.pollIntervalMillis,
      worker: readinessWorker(status),
      schema: Effect.void,
    })
    expect((yield* Effect.exit(readiness.check))._tag).toBe("Failure")

    yield* Ref.set(
      status,
      workerStatus(
        { _tag: "Succeeded", at: 10_000 },
        {
          lastFailure: retainedFailure,
          active: 4,
          capacity: 4,
          oldestClaimAt: 1,
        },
      ),
    )
    expect(yield* readiness.check).toEqual({
      backend: "postgres",
      source: options.source,
      workerId: worker.workerId,
    })
    expect(yield* readiness.status).toEqual({
      poll: { _tag: "Succeeded", at: 10_000 },
      lastSuccessfulPollAt: 10_000,
      lastFailure: retainedFailure,
      active: 4,
      capacity: 4,
      oldestClaimAt: 1,
      pollAgeMillis: 0,
      lastSuccessfulPollAgeMillis: 0,
      oldestClaimAgeMillis: 9_999,
      lastFailureAgeMillis: 2_000,
      availableCapacity: 0,
    })
  }),
)
