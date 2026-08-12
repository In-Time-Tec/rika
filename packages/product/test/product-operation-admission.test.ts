import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { makeProductOperationAdmission } from "../src/operation/dispatch/product-operation-admission"

const link = { runId: "run", turnId: "turn", threadId: "thread" }

it.effect("closes mutation admission and drains an interrupted mutation before replacement", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const rawBackend = ExecutionGateway.Service.of({
      startTurn: () => Effect.die("unused"),
      cancelTurn: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      steerTurn: () => Effect.die("unused"),
      approveTurn: () => Effect.die("unused"),
      denyTurn: () => Effect.die("unused"),
      watchTurn: () => Stream.empty,
      inspectTurn: () => Effect.die("unused"),
    })
    const admission = yield* makeProductOperationAdmission({ rawBackend })
    const mutation = yield* Effect.forkChild(admission.acquiredBackend.cancelTurn(link, "test"))
    yield* Deferred.await(started)
    const prepared = yield* Deferred.make<void>()
    const preparation = yield* Effect.forkChild(
      admission.prepareServerReplacement.pipe(Effect.andThen(Deferred.succeed(prepared, undefined))),
    )
    yield* Effect.yieldNow
    expect((yield* Effect.result(admission.acquiredBackend.cancelTurn(link, "late")))._tag).toBe("Failure")
    expect(yield* Deferred.isDone(prepared)).toBe(false)
    yield* Fiber.interrupt(mutation)
    yield* Fiber.join(preparation)
    expect(yield* Deferred.isDone(prepared)).toBe(true)
  }),
)
