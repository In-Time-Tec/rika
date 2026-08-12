import { Effect } from "effect"
import type { OperationError } from "../operation-error"
import type { ProductOperationRuntimeState } from "./product-operation-runtime-state"
import type { ProductLayerOptions } from "./product-operation-options"
import type { ExecutionIngest } from "../../execution/service/execution-ingest"

export interface ProductOperationScheduleInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly ownerScope: import("effect").Scope.Scope
  readonly ingest: ExecutionIngest
  readonly repairThreadSummaries: ProductOperationRuntimeState["repairThreadSummaries"]
  readonly executionDependencies: ProductOperationRuntimeState["executionDependencies"]
}

export interface ProductOperationSchedule {
  readonly repairSummariesOnce: Effect.Effect<void, never, never>
}

export const makeProductOperationSchedule = (
  input: ProductOperationScheduleInput,
): Effect.Effect<ProductOperationSchedule, OperationError> =>
  Effect.gen(function* () {
    // The server-scope execution coordinator owns every active-turn watch for every path:
    // interactive submits, queued promotion, retries, noninteractive runs, and recovery. It
    // outlives any client session, so execution never dies with the client that asked for it.
    yield* Effect.forkIn(input.ingest.supervise, input.ownerScope)
    const repairSummariesOnce = yield* Effect.cached(
      input.repairThreadSummaries.pipe(
        Effect.provide(input.executionDependencies),
        Effect.catch((error: unknown) =>
          Effect.logError("thread-summary.repair.failed").pipe(Effect.annotateLogs("rika.failure.kind", String(error))),
        ),
      ),
    )
    return { repairSummariesOnce }
  })
