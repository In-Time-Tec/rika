import type { Tool } from "effect/unstable/ai"
import { Effect } from "effect"
import type { ChildExecutionMethodsInput } from "./relay-child-execution-context"
import * as Mapping from "./relay-event-mapping"
import * as Identifier from "./relay-execution-identifier"
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
        Effect.mapError(Mapping.error),
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
          execution_id: Identifier.workflowExecutionId({ runId, ownerTurnId, workspace }),
          workflow_definition_id: idFor(name),
          ...(revision === undefined ? {} : { revision }),
        })
        .pipe(Effect.mapError(Mapping.error))
      return Mapping.workflow(result)
    }),
    inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (
      runId: string,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .inspectRun(Identifier.workflowExecutionId({ runId, ownerTurnId, workspace }))
        .pipe(Effect.mapError(Mapping.error))
      return result === undefined ? undefined : Mapping.workflow(result)
    }),
    cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (
      runId: string,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .cancelRun(Identifier.workflowExecutionId({ runId, ownerTurnId, workspace }))
        .pipe(Effect.mapError(Mapping.error))
      return result === undefined ? undefined : Mapping.workflow(result)
    }),
  }
}
