import { error, workflow } from "./relay-event-payload"
import type { Tool } from "effect/unstable/ai"
import { Effect } from "effect"
import type { ChildExecutionMethodsInput } from "./relay-child-execution-context"
import { workflowExecutionId } from "./relay-execution-id-codec"
import { definitions, idFor } from "../relay-workflow-compiler"

export const workflowMethods = <AdditionalTools extends Record<string, Tool.Any>>(
  input: ChildExecutionMethodsInput<AdditionalTools>,
) => {
  const { client } = input
  return {
    registerWorkflows: Effect.fn("ExecutionBackend.registerWorkflows")(function* () {
      return yield* Effect.forEach(definitions, (definition) => client.workflows.registerDefinition(definition), {
        concurrency: 1,
      }).pipe(
        Effect.map((records) =>
          records.map(({ record }) => ({
            name: record.definition.name,
            revision: record.revision,
            digest: record.digest,
          })),
        ),
        Effect.mapError(error),
      )
    }),
    startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(function* (
      name: string,
      runId: string,
      revision: number | undefined,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .startRun({
          execution_id: workflowExecutionId({ runId, ownerTurnId, workspace }),
          workflow_definition_id: idFor(name),
          ...(revision === undefined ? {} : { revision }),
        })
        .pipe(Effect.mapError(error))
      return workflow(result)
    }),
    inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (
      runId: string,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .inspectRun(workflowExecutionId({ runId, ownerTurnId, workspace }))
        .pipe(Effect.mapError(error))
      return result === undefined ? undefined : workflow(result)
    }),
    cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (
      runId: string,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .cancelRun(workflowExecutionId({ runId, ownerTurnId, workspace }))
        .pipe(Effect.mapError(error))
      return result === undefined ? undefined : workflow(result)
    }),
  }
}
