import { childSessionId } from "../relay-execution-id-codec"
import { relayModelSelection } from "../../../model/routing/relay-model-selection"
import { toolkitFor } from "../../../model/routing/relay-model-tools"
import { compactionPolicy } from "../../../model/routing/relay-model-compaction"
import { WorkflowDefinitionHost, Client, Content, Ids } from "@relayfx/sdk"
import { Deferred, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { LayerOptions } from "../relay-execution-adapter"
import * as IdentifierCodec from "../relay-execution-id-codec"
import * as ToolAdapter from "../relay-tool-runtime"
import { presets } from "../../../agent/definition/baton-agent-definition"

export const makeWorkflowHost = <AdditionalTools extends Record<string, Tool.Any>>(deps: {
  readonly options: Pick<
    LayerOptions<AdditionalTools>,
    | "additionalToolkit"
    | "selection"
    | "oracleSelection"
    | "compaction"
    | "oracleCompaction"
    | "compactionSummarySelection"
  >
  readonly relayClient: Deferred.Deferred<Client.Interface>
  readonly addressId: Ids.AddressId
  readonly toolExecutionPolicy: { readonly concurrency: "unbounded" }
  readonly childResult: typeof import("./relay-fan-out-host").childResult
}) => {
  const workflowHandlers = Layer.succeed(
    WorkflowDefinitionHost.Service,
    WorkflowDefinitionHost.Service.of({
      child: (parentId, operation, context) => {
        const parentExecutionId = String(parentId)
        const childId = IdentifierCodec.makeChildExecutionId({
          parentTurnId: parentExecutionId,
          childId: String(operation.id),
        })
        const grounded = "address_id" in operation
        const profileName = grounded ? String(operation.preset_name) : "Task"
        const availablePresets = presets({ model: deps.options.selection, oracleModel: deps.options.oracleSelection })
        const preset = availablePresets[profileName] ?? availablePresets.Task!
        const childSelection = {
          provider: preset.model.provider,
          model: preset.model.model,
          ...(preset.model.registration_key === undefined ? {} : { registrationKey: preset.model.registration_key }),
        }
        const childAgentId = Ids.AgentId.make(
          `agent:rika:workflow:${encodeURIComponent(parentExecutionId)}:${String(operation.id)}`,
        )
        const policy = compactionPolicy({
          compaction:
            profileName === "Oracle"
              ? (deps.options.oracleCompaction ?? deps.options.compaction)
              : deps.options.compaction,
          summaryModel: deps.options.compactionSummarySelection,
        })
        return Deferred.await(deps.relayClient).pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              const childToolkit = Toolkit.make(
                ...Object.values(toolkitFor(deps.options).tools).filter((tool) =>
                  preset.tool_names.includes(tool.name),
                ),
              )
              const encodedInput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(operation.input ?? {})
              const registerAgent = (input: Client.RegisterDefinedAgentInput) => client.agents.register(input)
              const registered = yield* registerAgent({
                id: childAgentId,
                address: grounded ? operation.address_id : deps.addressId,
                name: `rika-workflow-${String(childId)}`,
                instructions: preset.instructions,
                model: relayModelSelection(childSelection),
                tools: Object.values(childToolkit.tools).map((tool) => ({ name: tool.name })),
                tool_execution: deps.toolExecutionPolicy,
                permissions: preset.permissions.map((name) => ({ name, value: true })),
                permission_rules: ToolAdapter.allowAllPermissionRules,
                metadata: {
                  ...preset.metadata,
                  steering_enabled: true,
                  rika_execution_id: String(childId),
                },
                ...(policy === undefined ? {} : { compaction_policy: policy }),
              })
              yield* client.executions
                .startByAgentDefinition({
                  root_address_id: grounded ? operation.address_id : deps.addressId,
                  session_id: childSessionId(childId),
                  agent_id: childAgentId,
                  agent_revision: registered.record.current_revision,
                  execution_id: Ids.ExecutionId.make(String(childId)),
                  input: [Content.text(encodedInput)],
                  idempotency_key: context.idempotency_key,
                  metadata: {
                    child_execution_id: childId,
                    rika_permissions: [...preset.permissions],
                    workflow_operation_id: operation.id,
                  },
                })
                .pipe(
                  Effect.catchTag("ClientError", (startError) =>
                    client.executions
                      .get(Ids.ExecutionId.make(String(childId)))
                      .pipe(
                        Effect.flatMap((existing) =>
                          existing === undefined ? Effect.fail(startError) : Effect.succeed(existing),
                        ),
                      ),
                  ),
                )
              return (yield* deps.childResult({ client, childId: String(childId) })).output
            }).pipe(Effect.mapError((cause) => WorkflowDefinitionHost.HandlerError.make({ message: String(cause) }))),
          ),
          Effect.mapError((cause) => WorkflowDefinitionHost.HandlerError.make({ message: String(cause) })),
        )
      },
      approval: (_parentId, operation) => Effect.succeed({ approved: true, prompt: operation.prompt }),
      timer: (_parentId, operation) => Effect.sleep(`${operation.duration_ms} millis`),
      branch: () => Effect.succeed(true),
      structuredCompletion: (_schema, value) => Effect.succeed(value ?? null),
    }),
  )
  return workflowHandlers
}
