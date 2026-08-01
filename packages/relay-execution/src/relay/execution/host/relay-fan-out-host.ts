import { childSessionId } from "../relay-execution-id-codec"
import { relayModelSelection } from "../../../model/routing/relay-model-selection"
import { ChildFanOutHost, Client, Ids } from "@relayfx/sdk"
import { Clock, Deferred, Effect, Layer, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as ToolAdapter from "../relay-tool-runtime"
import type { LayerOptions } from "../relay-execution-adapter"
import { parentPermissions } from "../../../agent/definition/agent-permissions"

export const childResult = (input: { readonly client: Client.Interface; readonly childId: string }) => {
  const childExecutionId = Ids.ExecutionId.make(input.childId)
  return input.client.executions.stream({ execution_id: childExecutionId }).pipe(
    Stream.takeUntil(
      (item) =>
        item.type === "execution.completed" || item.type === "execution.failed" || item.type === "execution.cancelled",
    ),
    Stream.runCollect,
    Effect.map((events) => {
      const terminal = events.findLast(
        (executionEvent) =>
          executionEvent.type === "execution.completed" ||
          executionEvent.type === "execution.failed" ||
          executionEvent.type === "execution.cancelled",
      )
      const modelOutput = events.findLast((executionEvent) => executionEvent.type === "model.output.completed")
      let status: "completed" | "cancelled" | "failed" = "failed"
      if (terminal?.type === "execution.completed") status = "completed"
      else if (terminal?.type === "execution.cancelled") status = "cancelled"
      return {
        status,
        output:
          terminal?.content === undefined || terminal.content.length === 0
            ? (modelOutput?.content ?? [])
            : terminal.content,
      }
    }),
  )
}
export const makeFanOutHost = (context: {
  readonly relayClient: Deferred.Deferred<Client.Interface>
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly options: Pick<
    LayerOptions,
    "selection" | "oracleSelection" | "compaction" | "oracleCompaction" | "compactionSummarySelection"
  >
  readonly fanOutAgentId: typeof import("../relay-execution-input").fanOutAgentId
  readonly addressId: Ids.AddressId
  readonly parentPermissions: typeof parentPermissions
  readonly toolExecutionPolicy: { readonly concurrency: "unbounded" }
}) => {
  const fanOutHandlers = Layer.succeed(
    ChildFanOutHost.Service,
    ChildFanOutHost.Service.of({
      execute: (child, fanOutState, idempotencyKey) =>
        Deferred.await(context.relayClient).pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              const override = child.override ?? {}
              const childToolkit = Toolkit.make(
                ...(Object.values(context.toolkit.tools) as Array<import("effect/unstable/ai").Tool.Any>).filter(
                  (tool) => override.tool_names === undefined || override.tool_names.includes(tool.name),
                ),
              )
              const metadata = {
                steering_enabled: true,
                ...override.metadata,
                ...child.metadata,
                rika_execution_id: String(child.child_execution_id),
              }
              const childSelection =
                override.model === undefined
                  ? context.options.selection
                  : {
                      provider: override.model.provider,
                      model: override.model.model,
                      ...(override.model.registration_key === undefined
                        ? {}
                        : {
                            registrationKey: override.model.registration_key,
                          }),
                    }
              const childAgentId = context.fanOutAgentId({
                fanOutId: String(fanOutState.fan_out_id),
                childExecutionId: String(child.child_execution_id),
              })
              const registerAgent = (input: Client.RegisterDefinedAgentInput) => client.agents.register(input)
              const registered = yield* registerAgent({
                id: childAgentId,
                address: child.address_id,
                name: `rika-fan-out-${String(child.child_execution_id)}`,
                ...(override.instructions === undefined ? {} : { instructions: override.instructions }),
                model: relayModelSelection(childSelection),
                tools: Object.values(childToolkit.tools).map((tool) => ({ name: tool.name })),
                tool_execution: context.toolExecutionPolicy,
                permissions:
                  override.permissions === undefined
                    ? context.parentPermissions
                    : override.permissions.map((name: string) => ({ name, value: true })),
                permission_rules: ToolAdapter.allowAllPermissionRules,
                ...(override.output_schema_ref === undefined ? {} : { output_schema_ref: override.output_schema_ref }),
                metadata,
                ...(override.compaction_policy === undefined ? {} : { compaction_policy: override.compaction_policy }),
              })
              yield* client.executions.startByAgentDefinition({
                root_address_id: child.address_id,
                session_id: childSessionId(child.child_execution_id),
                agent_id: childAgentId,
                agent_revision: registered.record.current_revision,
                execution_id: Ids.ExecutionId.make(String(child.child_execution_id)),
                ...(child.input === undefined ? {} : { input: child.input }),
                idempotency_key: idempotencyKey,
                metadata: {
                  child_execution_id: child.child_execution_id,
                  fan_out_id: fanOutState.fan_out_id,
                  rika_permissions:
                    override.permissions === undefined
                      ? context.parentPermissions
                          .filter((permission) => permission.value === true)
                          .map((permission) => permission.name)
                      : [...override.permissions],
                  ...child.metadata,
                },
              })
              return yield* childResult({ client, childId: String(child.child_execution_id) })
            }).pipe(Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) }))),
          ),
          Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) })),
        ),
      cancel: (childExecutionId) =>
        Deferred.await(context.relayClient).pipe(
          Effect.flatMap((client) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((cancelledAt) =>
                client.executions.cancel({
                  execution_id: Ids.ExecutionId.make(String(childExecutionId)),
                  cancelled_at: cancelledAt,
                }),
              ),
              Effect.asVoid,
              Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) })),
            ),
          ),
        ),
    }),
  )
  return fanOutHandlers
}
