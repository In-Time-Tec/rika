import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import {
  HostedTurnWorkerStore,
  type HostedTurnWorkerStoreService,
  type TurnClaim,
} from "@rika/product-store/turn-worker-store"
import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { HostedTurnWorker, layer as hostedTurnWorkerLayer } from "../../../src/hosted/thread/turn-worker"

const preparedFor = (
  input: Pick<ExecutionGateway.StartTurn, "threadId" | "turnId">,
): ExecutionGateway.PreparedTurn => ({
  threadId: input.threadId,
  turnId: input.turnId,
  runId: input.turnId,
  rootAdmissionJson: "{}",
})

const unavailableClaim: TurnClaim | undefined = undefined

it.effect("persists staged admission before activation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>()
      const claims = yield* Ref.make(0)
      const transitions = yield* Ref.make<ReadonlyArray<string>>([])
      const noClaim: TurnClaim | undefined = undefined
      const claim: TurnClaim = {
        workerId: "worker-test",
        claimToken: "claim-test",
        expiresAt: 30,
        activationRequested: false,
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
        renew: () => Effect.succeed(true),
        prepare: () => Ref.update(transitions, (value) => [...value, "persist-prepared"]).pipe(Effect.as(true)),
        completeAdmission: () => Ref.update(transitions, (value) => [...value, "persist-admission"]),
        requestActivation: () =>
          Ref.update(transitions, (value) => [...value, "request-activation"]).pipe(Effect.as(true)),
        completeActivation: () =>
          Ref.update(transitions, (value) => [...value, "complete"]).pipe(
            Effect.andThen(Deferred.succeed(completed, undefined)),
          ),
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        prepareTurn: (input) =>
          Ref.update(transitions, (value) => [...value, "prepare-runtime"]).pipe(Effect.as(preparedFor(input))),
        admitTurn: (input) =>
          Ref.update(transitions, (value) => [...value, "admit"]).pipe(
            Effect.as({
              runId: input.runId,
              turnId: input.turnId,
              threadId: input.threadId,
            }),
          ),
        activateTurn: () =>
          Ref.update(transitions, (value) => [...value, "activate"]).pipe(Effect.as("running" as const)),
      })
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
        }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )
      yield* Deferred.await(completed)
      yield* Effect.yieldNow
      yield* HostedTurnWorker.pipe(
        Effect.provide(context),
        Effect.flatMap((worker) => worker.ready),
      )
      expect(yield* Ref.get(claims)).toBeGreaterThanOrEqual(1)
      expect(yield* Ref.get(transitions)).toEqual([
        "prepare-runtime",
        "persist-prepared",
        "admit",
        "persist-admission",
        "request-activation",
        "activate",
        "complete",
      ])
    }),
  ),
)

it.effect("retries transient workspace capability prepare failures inside the claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      const claim: TurnClaim = {
        workerId: "worker-test",
        claimToken: "claim-test",
        expiresAt: 30,
        activationRequested: false,
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
      let claimed = false
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () => Effect.succeed(unavailableClaim),
        claimNext: () =>
          Effect.sync(() => {
            if (claimed) return unavailableClaim
            claimed = true
            return claim
          }),
        renew: () => Effect.succeed(true),
        prepare: () => Effect.succeed(true),
        completeAdmission: () => Effect.void,
        requestActivation: () => Effect.succeed(true),
        completeActivation: () => Deferred.succeed(completed, undefined),
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        prepareTurn: (input) =>
          Ref.getAndUpdate(attempts, (value) => value + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt < 2
                ? Effect.fail(
                    ExecutionGateway.PrepareTurnFailure.make({
                      kind: "unavailable",
                      message:
                        "Run requires unavailable workspace capabilities: filesystem: workspace root is unavailable",
                    }),
                  )
                : Effect.succeed(preparedFor(input)),
            ),
          ),
      })
      yield* Layer.build(
        hostedTurnWorkerLayer({ workerId: "worker-test", leaseMillis: 30_000, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )
      for (let step = 0; step < 6; step += 1) {
        yield* Effect.yieldNow
        if (yield* Deferred.isDone(completed)) break
        yield* TestClock.adjust("100 millis")
      }
      yield* Deferred.await(completed)
      expect(yield* Ref.get(attempts)).toBe(3)
    }),
  ),
)

it.effect("releases a failed pre-admission claim for immediate retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>()
      const claimed = yield* Ref.make(false)
      const claim: TurnClaim = {
        workerId: "worker-test",
        claimToken: "claim-test",
        expiresAt: 30,
        activationRequested: false,
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
        claimRecovery: () => Effect.succeed(unavailableClaim),
        claimNext: () =>
          Ref.getAndSet(claimed, true).pipe(Effect.map((alreadyClaimed) => (alreadyClaimed ? undefined : claim))),
        renew: () => Effect.succeed(true),
        prepare: () => Effect.die("failed preparation must not persist"),
        completeAdmission: () => Effect.die("failed preparation must not admit"),
        requestActivation: () => Effect.die("failed preparation must not activate"),
        completeActivation: () => Effect.die("failed preparation must not complete"),
        release: () => Deferred.succeed(released, undefined),
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        prepareTurn: () => Effect.die("workspace unavailable"),
      })
      yield* Layer.build(
        hostedTurnWorkerLayer({ workerId: "worker-test", leaseMillis: 30, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )

      yield* Deferred.await(released)
    }),
  ),
)

it.effect("cancels a durably admitted Runtime Run when cancellation won before the admission link was persisted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>()
      const claimed = yield* Ref.make(false)
      const transitions = yield* Ref.make<ReadonlyArray<string>>([])
      const preparedExecution = preparedFor({
        threadId: "thread-test",
        turnId: "turn-test",
      })
      const claim: TurnClaim = {
        workerId: "worker-test",
        claimToken: "claim-test",
        expiresAt: 30,
        preparedExecution,
        activationRequested: false,
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
        claimRecovery: () =>
          Ref.getAndSet(claimed, true).pipe(Effect.map((alreadyClaimed) => (alreadyClaimed ? undefined : claim))),
        claimNext: () => Effect.succeed(unavailableClaim),
        renew: () => Effect.succeed(true),
        prepare: () => Effect.die("prepared recovery claims must not be prepared again"),
        completeAdmission: () => Ref.update(transitions, (value) => [...value, "persist-admission"]),
        requestActivation: () =>
          Ref.update(transitions, (value) => [...value, "observe-cancellation"]).pipe(Effect.as(false)),
        completeActivation: (_claim, status) =>
          Ref.update(transitions, (value) => [...value, `complete-${status}`]).pipe(
            Effect.andThen(Deferred.succeed(completed, undefined)),
          ),
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        admitTurn: (input) =>
          Ref.update(transitions, (value) => [...value, "repeat-admission"]).pipe(
            Effect.as({
              runId: input.runId,
              turnId: input.turnId,
              threadId: input.threadId,
            }),
          ),
        activateTurn: () => Effect.die("cancelled staged admission must not activate"),
        cancelTurn: () => Ref.update(transitions, (value) => [...value, "cancel-runtime"]),
      })
      yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
        }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )

      yield* Deferred.await(completed)
      expect(yield* Ref.get(transitions)).toEqual([
        "repeat-admission",
        "persist-admission",
        "observe-cancellation",
        "cancel-runtime",
        "complete-cancelled",
      ])
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
        preparedExecution: preparedFor({ threadId, turnId }),
        activationRequested: false,
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
        renew: () => Effect.succeed(true),
        prepare: () => Effect.succeed(true),
        completeAdmission: () => Effect.void,
        requestActivation: () => Effect.succeed(true),
        completeActivation: (claim) =>
          claim.input.turnId === "turn-unrelated" ? Deferred.succeed(unrelatedCompleted, undefined) : Effect.void,
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        activateTurn: (input) =>
          input.turnId === "turn-blocked"
            ? Deferred.succeed(blockedStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed("running" as const),
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
      expect(yield* worker.status).toMatchObject({
        active: 1,
        capacity: 2,
        oldestClaimAgeMillis: 51,
      })
      yield* worker.ready
    }),
  ),
)

it.effect("interrupts workspace preparation when PostgreSQL claim renewal is lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const preparationStarted = yield* Deferred.make<void>()
      const preparationInterrupted = yield* Deferred.make<void>()
      const claim: TurnClaim = {
        workerId: "worker-test",
        claimToken: "claim-test",
        expiresAt: 30,
        activationRequested: false,
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
      const claimed = yield* Ref.make(false)
      const store: HostedTurnWorkerStoreService = {
        claimRecovery: () => Effect.succeed(unavailableClaim),
        claimNext: () =>
          Ref.getAndSet(claimed, true).pipe(Effect.map((alreadyClaimed) => (alreadyClaimed ? undefined : claim))),
        renew: () => Effect.succeed(false),
        prepare: () => Effect.die("lost claim must not persist preparation"),
        completeAdmission: () => Effect.die("lost claim must not admit"),
        requestActivation: () => Effect.die("lost claim must not activate"),
        completeActivation: () => Effect.die("lost claim must not complete"),
        release: () => Effect.void,
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        prepareTurn: () =>
          Deferred.succeed(preparationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(preparationInterrupted, undefined)),
          ),
      })
      yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
        }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
      )

      yield* Deferred.await(preparationStarted)
      yield* TestClock.adjust(10)
      yield* Deferred.await(preparationInterrupted)
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
        preparedExecution: preparedFor({
          threadId: "thread-test",
          turnId: "turn-test",
        }),
        activationRequested: false,
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
        claimNext: () => Effect.succeed(unavailableClaim),
        renew: () => Effect.succeed(true),
        prepare: () => Effect.die("prepared recovery claims must not be prepared again"),
        completeAdmission: () => Effect.void,
        requestActivation: () => Effect.succeed(true),
        completeActivation: (claim) =>
          Ref.update(completedTokens, (tokens) => [...tokens, claim.claimToken]).pipe(
            Effect.andThen(Deferred.succeed(secondCompleted, undefined)),
          ),
        release: (claim) => Ref.update(releasedTokens, (tokens) => [...tokens, claim.claimToken]),
      }
      const gateway = ExecutionGateway.Service.of({
        ...ExecutionGateway.makeTest(),
        activateTurn: () =>
          Ref.getAndUpdate(executionIndex, (value) => value + 1).pipe(
            Effect.flatMap((index) =>
              index === 0
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(firstInterrupted, undefined)),
                  )
                : Deferred.succeed(secondStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseSecond)),
                    Effect.as("running" as const),
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
        claimNext: () => Effect.succeed(unavailableClaim),
        renew: () => Effect.succeed(true),
        prepare: () => Effect.die("unused"),
        completeAdmission: () => Effect.die("unused"),
        requestActivation: () => Effect.die("unused"),
        completeActivation: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
      }
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
        }).pipe(
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
        claimNext: () => Effect.succeed(unavailableClaim),
        renew: () => Effect.succeed(true),
        prepare: () => Effect.die("unused"),
        completeAdmission: () => Effect.die("unused"),
        requestActivation: () => Effect.die("unused"),
        completeActivation: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
      }
      const context = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: "worker-test",
          leaseMillis: 30,
          pollIntervalMillis: 10,
        }).pipe(
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
