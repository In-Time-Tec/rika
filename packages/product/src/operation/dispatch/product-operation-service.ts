import { Context, Effect, Ref, Semaphore } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
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
  const typedHasActiveExecutionWork: () => Effect.Effect<boolean, OperationUnavailable, never> = hasActiveExecutionWork
  const typedExecutionDependencies: Context.Context<ExecutionBackend.Service> = executionDependencies
  const typedReplacementAdmission: Semaphore.Semaphore = replacementAdmission
  const typedReplacementState: Ref.Ref<{ readonly closed: boolean; readonly active: number }> = replacementState
  const typedActiveWorkflows: Map<
    string,
    { readonly runId: string; readonly ownerTurnId?: string; readonly workspace?: string }
  > = activeWorkflows
  const typedRawBackend: ExecutionBackend.Interface = rawBackend
  return Service.of({
    hasActiveExecutionWork: typedHasActiveExecutionWork().pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ResidentReplacement", message: String(error) }),
      ),
    ),
    stopActiveExecutionWork: stopActiveExecutionWorkWithProjection().pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ResidentAbandonment", message: String(error) }),
      ),
    ),
    authorizeResidentReplacement: typedReplacementAdmission.withPermits(1)(
      Effect.gen(function* () {
        const replacement = (yield* Ref.get(typedReplacementState)) as {
          readonly closed: boolean
          readonly active: number
        }
        if (replacement.closed) return "supersede" as const
        if (
          replacement.active > 0 ||
          (yield* typedHasActiveExecutionWork().pipe(Effect.provide(typedExecutionDependencies))) === true
        )
          return "defer" as const
        for (const [key, workflow] of typedActiveWorkflows) {
          const inspection = yield* typedRawBackend.inspectWorkflow(
            workflow.runId,
            workflow.ownerTurnId,
            workflow.workspace,
          )
          if (inspection?.status === "running") return "defer" as const
          typedActiveWorkflows.delete(key)
        }
        yield* Ref.set(typedReplacementState, { closed: true, active: 0 })
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
