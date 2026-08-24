import { Effect } from "effect"
import { operationError, type OperationError } from "../error"
import type { ProductOperationRuntimeState } from "../runtime/state"
import type { ProductLayerOptions } from "../foundation/options"
import type { ProductOperationInteractiveSessionFactory } from "../runtime/session"
import type { InteractiveSessionRuntimeResult } from "../interactive/session"

export interface ProductOperationScheduleInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly ownerScope: import("effect").Scope.Scope
  readonly makeInteractiveSession: ProductOperationRuntimeState["makeInteractiveSession"]
  readonly repairThreadSummaries: ProductOperationRuntimeState["repairThreadSummaries"]
  readonly executionDependencies: ProductOperationRuntimeState["executionDependencies"]
}

export interface ProductOperationSchedule {
  readonly owner: InteractiveSessionRuntimeResult
  readonly repairSummariesOnce: Effect.Effect<void, never, never>
}

export const makeProductOperationSchedule = (
  input: ProductOperationScheduleInput,
): Effect.Effect<ProductOperationSchedule, OperationError> =>
  Effect.gen(function* () {
    const makeInteractiveSession: ProductOperationInteractiveSessionFactory = input.makeInteractiveSession
    const owner = yield* makeInteractiveSession(input.options.defaultWorkspace, { recoveryOwner: true })
    yield* Effect.forkIn(owner.supervise, input.ownerScope)
    yield* owner.initialized.pipe(Effect.mapError((error) => operationError(String(error), error)))
    const repairSummariesOnce = yield* Effect.cached(
      input.repairThreadSummaries.pipe(
        Effect.provide(input.executionDependencies),
        Effect.catch((error: unknown) =>
          Effect.logError("thread-summary.repair.failed").pipe(Effect.annotateLogs("rika.failure.kind", String(error))),
        ),
      ),
    )
    return { owner, repairSummariesOnce }
  })
