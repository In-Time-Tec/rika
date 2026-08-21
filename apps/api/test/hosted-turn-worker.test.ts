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
import { HostedTurnWorker, layer as hostedTurnWorkerLayer } from "../src/hosted-turn-worker"

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
