import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import {
  HostedTurnWorkerStore,
  type HostedTurnWorkerStoreService,
  type TurnClaim,
} from "@rika/product-store/postgres-turn-worker-store"
import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { HostedTurnWorker, layer as hostedTurnWorkerLayer } from "../../../src/hosted/thread/turn-worker"

it.effect("starts a claimed Turn while renewing its lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const claims = yield* Ref.make(0)
      const renewals = yield* Ref.make(0)
      const noClaim: TurnClaim | undefined = undefined
      const claim: TurnClaim = {
        workerId: "worker-test",
        claimToken: "claim-test",
        expiresAt: 30,
        prepared: false,
        ownerId: "owner-test",
        claimedAt: 0,
        input: {
          threadId: "thread-test",
          turnId: "turn-test",
          workspaceId: "workspace-test",
          prompt: "test",
          executionRoute: ExecutionRoute.testExecutionRoute(),
        },
      }
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () => Effect.succeed(noClaim),
        claimNext: () =>
          Ref.getAndUpdate(claims, (value) => value + 1).pipe(Effect.map((value) => (value === 0 ? claim : undefined))),
        prepare: () => Effect.succeed(true),
        renew: () => Ref.update(renewals, (value) => value + 1).pipe(Effect.as(true)),
        complete: () => Deferred.succeed(completed, undefined),
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        startTurn: (input) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ runId: "run-test", turnId: input.turnId, threadId: input.threadId }),
          ),
      })
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({ workerId: "worker-test", leaseMillis: 30, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )
      yield* Deferred.await(started)
      yield* TestClock.adjust(11)
      expect(yield* Ref.get(renewals)).toBeGreaterThan(0)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(completed)
      yield* HostedTurnWorker.pipe(
        Effect.provide(context),
        Effect.flatMap((worker) => worker.ready),
      )
      expect(yield* Ref.get(claims)).toBeGreaterThanOrEqual(1)
    }),
  ),
)

it.effect("does not let one nonresponsive Turn starve an unrelated claimed Turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const blockedStarted = yield* Deferred.make<void>()
      const unrelatedCompleted = yield* Deferred.make<void>()
      const claimIndex = yield* Ref.make(0)
      const makeClaim = (turnId: string, threadId: string): TurnClaim => ({
        workerId: "worker-test",
        claimToken: `claim-${turnId}`,
        expiresAt: 30,
        prepared: true,
        ownerId: "owner-test",
        claimedAt: 0,
        input: {
          threadId,
          turnId,
          workspaceId: "workspace-test",
          prompt: "test",
          executionRoute: ExecutionRoute.testExecutionRoute(),
        },
      })
      const claims = [makeClaim("turn-blocked", "thread-blocked"), makeClaim("turn-unrelated", "thread-unrelated")]
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () => Effect.void.pipe(Effect.as<TurnClaim | undefined>(undefined)),
        claimNext: () => Ref.getAndUpdate(claimIndex, (value) => value + 1).pipe(Effect.map((index) => claims[index])),
        prepare: () => Effect.succeed(true),
        renew: () => Effect.succeed(true),
        complete: (claim) =>
          claim.input.turnId === "turn-unrelated" ? Deferred.succeed(unrelatedCompleted, undefined) : Effect.void,
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        startTurn: (input) =>
          input.turnId === "turn-blocked"
            ? Deferred.succeed(blockedStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ runId: "run-unrelated", turnId: input.turnId, threadId: input.threadId }),
      })
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
          concurrency: 2,
        }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )

      yield* Deferred.await(blockedStarted)
      yield* TestClock.adjust(11)
      expect((yield* Deferred.poll(unrelatedCompleted))._tag).toBe("Some")
      const worker = Context.get(context, HostedTurnWorker)
      yield* TestClock.adjust(40)
      expect(yield* worker.status).toMatchObject({ active: 1, capacity: 2, oldestClaimAgeMillis: 51 })
      yield* worker.ready
    }),
  ),
)

it.effect("replaces stale local execution when the same prepared Turn is reclaimed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const firstInterrupted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      const secondCompleted = yield* Deferred.make<void>()
      const claimIndex = yield* Ref.make(0)
      const executionIndex = yield* Ref.make(0)
      const completedTokens = yield* Ref.make<ReadonlyArray<string>>([])
      const releasedTokens = yield* Ref.make<ReadonlyArray<string>>([])
      const makeClaim = (claimToken: string, claimedAt: number): TurnClaim => ({
        workerId: "worker-test",
        claimToken,
        expiresAt: 30,
        prepared: true,
        ownerId: "owner-test",
        claimedAt,
        input: {
          threadId: "thread-test",
          turnId: "turn-test",
          workspaceId: "workspace-test",
          prompt: "test",
          executionRoute: ExecutionRoute.testExecutionRoute(),
        },
      })
      const claims = [makeClaim("claim-old", 1), makeClaim("claim-new", 10)]
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () =>
          Ref.getAndUpdate(claimIndex, (value) => value + 1).pipe(Effect.map((index) => claims[index])),
        claimNext: () => Effect.void.pipe(Effect.as<TurnClaim | undefined>(undefined)),
        prepare: () => Effect.die("prepared recovery claims must not be prepared again"),
        renew: () => Effect.succeed(true),
        complete: (claim) =>
          Ref.update(completedTokens, (tokens) => [...tokens, claim.claimToken]).pipe(
            Effect.andThen(Deferred.succeed(secondCompleted, undefined)),
          ),
        release: (claim) => Ref.update(releasedTokens, (tokens) => [...tokens, claim.claimToken]),
      }
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        startTurn: (input) =>
          Ref.getAndUpdate(executionIndex, (value) => value + 1).pipe(
            Effect.flatMap((index) =>
              index === 0
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(firstInterrupted, undefined)),
                  )
                : Deferred.succeed(secondStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseSecond)),
                    Effect.as({ runId: "run-new", turnId: input.turnId, threadId: input.threadId }),
                  ),
            ),
          ),
      })
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
          concurrency: 2,
        }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )

      yield* Deferred.await(firstStarted)
      yield* Deferred.await(secondStarted)
      yield* Deferred.await(firstInterrupted)
      const status = yield* HostedTurnWorker.pipe(
        Effect.provide(context),
        Effect.flatMap((worker) => worker.status),
      )
      expect(status.oldestClaimAt).toBe(10)
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* Deferred.await(secondCompleted)
      expect(yield* Ref.get(completedTokens)).toEqual(["claim-new"])
      expect(yield* Ref.get(releasedTokens)).toEqual([])
    }),
  ),
)

it.effect("rejects a stale Turn worker when claiming blocks after a successful poll", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const claims = yield* Ref.make(0)
      const blocked = yield* Deferred.make<TurnClaim | undefined>()
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () =>
          Ref.getAndUpdate(claims, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 0 ? Effect.void.pipe(Effect.as<TurnClaim | undefined>(undefined)) : Deferred.await(blocked),
            ),
          ),
        claimNext: () => Effect.void.pipe(Effect.as<TurnClaim | undefined>(undefined)),
        prepare: () => Effect.die("unused"),
        renew: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
      }
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({ workerId: "worker-test", leaseMillis: 30, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(ExecutionGateway.layerTest()),
          Layer.provide(BunCrypto.layer),
        ),
      )
      const worker = Context.get(context, HostedTurnWorker)
      yield* Effect.yieldNow
      yield* worker.ready
      yield* TestClock.adjust(51)
      expect((yield* Effect.exit(worker.ready))._tag).toBe("Failure")
    }),
  ),
)

it.effect("rejects the current Turn claim failure immediately", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () => Effect.die("claim unavailable"),
        claimNext: () => Effect.void.pipe(Effect.as<TurnClaim | undefined>(undefined)),
        prepare: () => Effect.die("unused"),
        renew: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
      }
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({ workerId: "worker-test", leaseMillis: 30, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(ExecutionGateway.layerTest()),
          Layer.provide(BunCrypto.layer),
        ),
      )
      const worker = Context.get(context, HostedTurnWorker)
      yield* Effect.yieldNow
      expect((yield* worker.status).poll._tag).toBe("Failed")
      expect((yield* Effect.exit(worker.ready))._tag).toBe("Failure")
    }),
  ),
)
