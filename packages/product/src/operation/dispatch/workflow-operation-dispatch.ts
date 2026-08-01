import * as ExecutionBackend from "../../execution/contract/execution-service"
import { Input } from "../contract/product-operation"
import { OperationUnavailable } from "../contract/product-operation"
import { operationError } from "../operation-error"
import { Console, Context, Effect } from "effect"

export interface Dependencies {
  readonly backend: ExecutionBackend.Interface
  readonly encodeJson: (value: unknown) => string
  readonly unavailable: (input: Input, message: string) => OperationUnavailable
}

export const run = Effect.fn("WorkflowOperation.run")(function* (
  input: Extract<Input, { readonly _tag: "Workflow" }>,
  dependencies: Dependencies,
) {
  const program = Effect.gen(function* () {
    const backend = yield* ExecutionBackend.Service
    if (input.action === "start") {
      yield* backend.registerWorkflows()
      yield* Console.log(
        dependencies.encodeJson(
          yield* backend.startWorkflow(input.name, input.runId, input.revision, undefined, input.clientWorkspace),
        ),
      )
      return
    }
    const inspection =
      input.action === "inspect"
        ? yield* backend.inspectWorkflow(input.runId, undefined, input.clientWorkspace)
        : yield* backend.cancelWorkflow(input.runId, undefined, input.clientWorkspace)
    if (inspection === undefined) return yield* operationError(`Workflow run ${input.runId} does not exist`)
    yield* Console.log(dependencies.encodeJson(inspection))
  })
  yield* program.pipe(
    Effect.provide(Context.make(ExecutionBackend.Service, dependencies.backend)),
    Effect.mapError((error) => dependencies.unavailable(input, error instanceof Error ? error.message : String(error))),
  )
})
