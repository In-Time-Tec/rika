import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { makeProductOperationAdmission } from "../src/operation/dispatch/product-operation-admission"
import {
  makeProductOperationSchedule,
  type ProductOperationScheduleInput,
} from "../src/operation/dispatch/product-operation-schedule"
import { OperationError } from "../src/operation/operation-error"
import type { InteractiveSessionRuntimeResult } from "../src/operation/interactive/session"

const link = { runId: "run", turnId: "turn", threadId: "thread" }

it.effect("closes mutation admission and drains an interrupted mutation before shutdown", () =>
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
      admission.closeAdmissions.pipe(Effect.andThen(Deferred.succeed(prepared, undefined))),
    )
    yield* Effect.yieldNow
    expect((yield* Effect.result(admission.acquiredBackend.cancelTurn(link, "late")))._tag).toBe("Failure")
    expect(yield* Deferred.isDone(prepared)).toBe(false)
    yield* Fiber.interrupt(mutation)
    yield* Fiber.join(preparation)
    expect(yield* Deferred.isDone(prepared)).toBe(true)
  }),
)

it.effect("fails operation startup when initial execution supervision fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = OperationError.make({ message: "startup recovery failed" })
      const initialized = yield* Deferred.make<void, OperationError>()
      const owner = {
        session: {},
        supervise: Deferred.fail(initialized, failure).pipe(Effect.andThen(Effect.fail(failure))),
        initialized: Deferred.await(initialized),
        watchClaimed: () => Effect.void,
        close: Effect.void,
      } as InteractiveSessionRuntimeResult
      const outcome = yield* makeProductOperationSchedule({
        options: { defaultWorkspace: "/work" },
        ownerScope: yield* Effect.scope,
        makeInteractiveSession: () => Effect.succeed(owner),
        repairThreadSummaries: Effect.void,
        executionDependencies: undefined,
      } as unknown as ProductOperationScheduleInput).pipe(Effect.result)
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OperationError", message: expect.stringContaining("startup recovery failed") },
      })
    }),
  ),
)
