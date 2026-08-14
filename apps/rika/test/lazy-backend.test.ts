import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as RootTurnOwner from "@rika/product/root-turn-owner"
import * as Thread from "@rika/product/thread-record"
import * as ThreadDeletion from "@rika/product/thread-deletion"
import * as ThreadRepository from "@rika/product/thread-repository"
import { Context, Effect, Layer, Semaphore, Stream } from "effect"
import { lazyBackendLayer } from "../src/server/composition/lazy-execution-backend"
import * as ExecutionProjection from "@rika/product/execution-projection"

it.effect("delegates the five execution operations through the deferred backend", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<string> = []
      const link = { runId: "opaque-run", turnId: "turn-1", threadId: "thread-1" }
      const service = Layer.succeed(
        ExecutionGateway.Service,
        ExecutionGateway.Service.of({
          startTurn: () => Effect.sync(() => (calls.push("start"), link)),
          cancelTurn: () => Effect.sync(() => calls.push("cancel")),
          steerTurn: () =>
            Effect.sync(() => {
              calls.push("steer")
              return { entryId: "test-steering", sequence: 0 }
            }),
          approveTurn: () => Effect.sync(() => calls.push("approve")),
          denyTurn: () => Effect.sync(() => calls.push("deny")),
          watchTurn: () => Stream.fromEffect(Effect.sync(() => calls.push("watch"))).pipe(Stream.drain),
          inspectTurn: () =>
            Effect.sync(() => (calls.push("inspect"), { status: "running" as const, cursor: "opaque-cursor" })),
        }),
      )
      const context = yield* Layer.build(lazyBackendLayer(service))
      const backend = Context.get(context, ExecutionGateway.Service)

      expect(
        yield* backend.startTurn({
          threadId: link.threadId,
          turnId: link.turnId,
          workspace: "/workspace",
          prompt: "test",
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute("medium"),
        }),
      ).toEqual(link)
      yield* backend.cancelTurn(link, "Cancelled by user")
      yield* backend.steerTurn(link, { text: "continue", idempotencyKey: "steer-1" })
      const authorization = {
        authorizationId: "authorization",
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "cursor", state: "{}" },
      }
      yield* backend.approveTurn(link, authorization)
      yield* backend.denyTurn(link, authorization)
      yield* Stream.runDrain(backend.watchTurn(link))
      expect(yield* backend.inspectTurn(link)).toEqual({ status: "running", cursor: "opaque-cursor" })
      expect(calls).toEqual(["start", "cancel", "steer", "approve", "deny", "watch", "inspect"])
    }),
  ),
)

it.effect("keeps deletion tombstoned when a gateway-only backend lacks session lifecycle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gatewayOnly = ExecutionGateway.layerTest()
      const context = yield* Layer.build(lazyBackendLayer(gatewayOnly))
      const sessions = Context.get(context, ExecutionSessionLifecycle.Service)
      const threadId = Thread.ThreadId.make("thread-without-lifecycle")
      let physicalThreadExists = true
      let tombstoneExists = false
      const threads = {
        requestDeletion: () =>
          Effect.sync(() => {
            tombstoneExists = true
          }),
        pendingDeletions: Effect.succeed([]),
        completeDeletion: () =>
          Effect.sync(() => {
            physicalThreadExists = false
            tombstoneExists = false
          }),
      } as unknown as ThreadRepository.Interface
      const rootTurns = {
        quiesceThread: () => Effect.void,
      } as unknown as RootTurnOwner.Interface
      const deletion = ThreadDeletion.make({
        threads,
        turns: { list: () => Effect.succeed([]) } as unknown as import("@rika/product/turn-repository").Interface,
        sessions,
        rootTurns,
        turnMutationAdmission: yield* Semaphore.make(1),
      })

      const failure = yield* Effect.flip(deletion.request(threadId))

      expect(failure).toMatchObject({
        _tag: "ExecutionSessionLifecycleUnavailable",
        message: "The execution backend does not provide session lifecycle cleanup",
      })
      expect(physicalThreadExists).toBe(true)
      expect(tombstoneExists).toBe(true)
    }),
  ),
)
