import { Effect, Ref } from "effect"
import { OperationUnavailable } from "../contract/product-operation"
import { Service } from "../contract/product-operation-service"
import { makeProductOperationRun } from "./product-operation-run"

export const makeProductOperationService = (input: any) => {
  const {
    options,
    state,
    schedule,
    executionDependencies,
    hasActiveExecutionWork,
    stopActiveExecutionWorkWithProjection,
    replacementAdmission,
    replacementState,
    activeWorkflows,
    rawBackend,
  } = input
  return Service.of({
    hasActiveExecutionWork: hasActiveExecutionWork().pipe(
      Effect.provide(executionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
      ),
    ),
    stopActiveExecutionWork: stopActiveExecutionWorkWithProjection().pipe(
      Effect.provide(executionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ResidentAbandonment", message: String(error) }),
      ),
    ),
    authorizeResidentReplacement: replacementAdmission.withPermits(1)(
      Effect.gen(function* () {
        const replacement = (yield* Ref.get(replacementState)) as { readonly closed: boolean; readonly active: number }
        if (replacement.closed) return "supersede" as const
        if (replacement.active > 0 || (yield* hasActiveExecutionWork().pipe(Effect.provide(executionDependencies))))
          return "defer" as const
        for (const [key, workflow] of activeWorkflows) {
          const inspection = yield* rawBackend.inspectWorkflow(workflow.runId, workflow.ownerTurnId, workflow.workspace)
          if (inspection?.status === "running") return "defer" as const
          activeWorkflows.delete(key)
        }
        yield* Ref.set(replacementState, { closed: true, active: 0 })
        return "supersede" as const
      }).pipe(
        Effect.mapError((error: unknown) =>
          OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
        ),
      ),
    ),
    run: makeProductOperationRun({
      ...input,
      ...state,
      ...schedule,
      toolRuntimeLayer: options.toolRuntimeLayer,
      backendLayer: state.backendLayer,
      backend: state.acquiredBackend,
      owner: schedule.owner,
      encodeJson: input.encodeJson,
      operationError: input.operationError,
      unavailable: input.unavailable,
      runAuth: input.runAuth,
      extensionOperations: input.extensionOperations,
      configOperations: input.configOperations,
    }),
  })
}
