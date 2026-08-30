import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { makeProductOperationAdmission } from "../../../src/operation/dispatch/admission"
import { makeProductOperationSchedule, type ProductOperationScheduleInput } from "../../../src/operation/run/schedule"
import { OperationError } from "../../../src/operation/error"

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
      const input = {
        options: { defaultWorkspace: "/work" },
        ownerScope: yield* Effect.scope,
        makeInteractiveSession: () => Effect.fail(failure),
        repairThreadSummaries: Effect.void,
        executionDependencies: undefined,
      } satisfies ProductOperationScheduleInput
      const outcome = yield* makeProductOperationSchedule(input).pipe(Effect.result)
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag === "Success") return
      expect(outcome.failure._tag).toBe("OperationError")
      expect(outcome.failure.message).toContain("startup recovery failed")
    }),
  ),
)
