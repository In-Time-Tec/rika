import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Stream } from "effect"
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
          steerTurn: () => Effect.sync(() => calls.push("steer")),
          approveTurn: () => Effect.sync(() => calls.push("approve")),
          denyTurn: () => Effect.sync(() => calls.push("deny")),
          watchTurn: () => Stream.fromEffect(Effect.sync(() => calls.push("watch"))).pipe(Stream.drain),
          inspectTurn: () => Effect.sync(() => (calls.push("inspect"), { status: "running" as const })),
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
      yield* backend.cancelTurn(link)
      yield* backend.steerTurn(link, { text: "continue", idempotencyKey: "steer-1" })
      const authorization = {
        authorizationId: "authorization",
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "cursor", state: "{}" },
      }
      yield* backend.approveTurn(link, authorization)
      yield* backend.denyTurn(link, authorization)
      yield* Stream.runDrain(backend.watchTurn(link))
      expect(yield* backend.inspectTurn(link)).toEqual({ status: "running" })
      expect(calls).toEqual(["start", "cancel", "steer", "approve", "deny", "watch", "inspect"])
    }),
  ),
)
