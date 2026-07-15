import * as ExecutionBackend from "@rika/runtime/contract"
import { Context, Effect, Layer, Schema } from "effect"

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()("ProductWorkflowError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly register: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly revision: number; readonly digest: string }>,
    WorkflowError
  >
  readonly start: (
    name: "delivery" | "research-synthesis",
    runId: string,
    revision?: number,
  ) => Effect.Effect<ExecutionBackend.WorkflowInspection, WorkflowError>
  readonly inspect: (runId: string) => Effect.Effect<ExecutionBackend.WorkflowInspection | undefined, WorkflowError>
  readonly cancel: (runId: string) => Effect.Effect<ExecutionBackend.WorkflowInspection | undefined, WorkflowError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/workflow/Service") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const backend = yield* ExecutionBackend.Service
    const mapError = (cause: ExecutionBackend.BackendError) => WorkflowError.make({ message: cause.message })
    return Service.of({
      register: backend.registerWorkflows().pipe(Effect.mapError(mapError)),
      start: Effect.fn("Workflow.start")((name, runId, revision) =>
        backend.startWorkflow(name, runId, revision).pipe(Effect.mapError(mapError)),
      ),
      inspect: Effect.fn("Workflow.inspect")((runId) => backend.inspectWorkflow(runId).pipe(Effect.mapError(mapError))),
      cancel: Effect.fn("Workflow.cancel")((runId) => backend.cancelWorkflow(runId).pipe(Effect.mapError(mapError))),
    })
  }),
)
