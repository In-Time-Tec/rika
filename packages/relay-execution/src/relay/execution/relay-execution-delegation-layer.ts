import { type RegistryInterface } from "./relay-thread-host-registry"
import { handlerLayer, promoteTurnTool } from "./relay-thread-host"
import { pinnedSelection, routeForProfile } from "../../model/routing/relay-model-selection"
import { toolkitFor } from "../../model/routing/relay-model-tools"
import { Deferred, Effect, Layer, Schema } from "effect"
import { Client, Content, Ids } from "@relayfx/sdk"
import { Toolkit } from "effect/unstable/ai"
import * as AgentSelection from "@rika/coding-tools/agent-tool-contract"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-contract"
import * as AgentTools from "@rika/coding-tools/agent-tool-contract"
import * as AgentErrors from "@rika/coding-tools/agent-tool-contract"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import { AgentProfile } from "@rika/product/execution-child-run"
import type { LayerOptions } from "./relay-execution-layer"
import { childExecutionDepth, delegationAvailableAtDepth } from "../../agent-depth"
import { parentPermissions } from "../../agent/definition/agent-permissions"
import { resolve } from "../../agent/definition/baton-agent-definition"
import * as Identifier from "./relay-execution-identifier"
import * as IdentifierCodec from "./relay-execution-id-codec"
import { pinnedRouteForExecution } from "./relay-execution-routing"

export const makeDelegationLayer = <
  AdditionalTools extends Record<string, import("effect/unstable/ai").Tool.Any>,
  RuntimeRequirements,
>(input: {
  readonly relayClient: Deferred.Deferred<Client.Interface>
  readonly options: LayerOptions<AdditionalTools, RuntimeRequirements>
  readonly promoterRegistry: RegistryInterface
  readonly addressId: Ids.AddressId
}) => {
  const { relayClient, options, promoterRegistry, addressId } = input
  const toolkit = toolkitFor(options)
  const runnerToolkit = Toolkit.make(
    ...Object.values(toolkit.tools).filter((tool) => tool.name !== AgentSelection.AgentContract.awaitSubagentsToolName),
    promoteTurnTool,
  )
  const delegation = Effect.fn("ExecutionBackend.delegateAgent")(function* (
    toolName: AgentSelection.DelegationToolName,
    profile: AgentProfile,
    delegationInput: AgentTools.TaskInput | AgentTools.ReadThreadInput,
  ) {
    const invocation = yield* ToolInvocation.ToolInvocation
    const parentExecutionId = Ids.ExecutionId.make(invocation.executionId)
    const parentDepth = childExecutionDepth(invocation.executionId)
    if (!delegationAvailableAtDepth(toolName, parentDepth))
      return yield* AgentErrors.AgentContract.AgentToolError.make({
        tool: toolName,
        message:
          toolName === "task"
            ? "Task subagents cannot start other Task subagents; complete the workspace work directly or use one focused specialist"
            : `Agent delegation is unavailable at depth ${parentDepth}`,
      })
    const client = yield* Deferred.await(relayClient)
    const parent = yield* client.executions
      .get(parentExecutionId)
      .pipe(
        Effect.mapError((cause) =>
          AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
        ),
      )
    if (parent === undefined)
      return yield* AgentErrors.AgentContract.AgentToolError.make({
        tool: toolName,
        message: `Execution ${invocation.executionId} was not found`,
      })
    const routePin = yield* pinnedRouteForExecution({ client, execution: parent }).pipe(
      Effect.mapError((cause) =>
        AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
      ),
    )
    if (routePin === undefined)
      return yield* AgentErrors.AgentContract.AgentToolError.make({
        tool: toolName,
        message: "The parent execution does not have a pinned model route",
      })
    const threadId = Identifier.threadIdFromMetadata(parent.metadata)
    const requestedPrompt =
      "threadId" in delegationInput && delegationInput.threadId !== undefined
        ? `Requested thread ID: ${delegationInput.threadId}\n\n${delegationInput.prompt}`
        : delegationInput.prompt
    const childDepth = parentDepth + 1
    const childRoute = routeForProfile({ pin: routePin, profile })
    const childPreset = resolve(profile, pinnedSelection(childRoute)).preset
    const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(
      Effect.mapError((cause) =>
        AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
      ),
    )
    const child = {
      child_execution_id: IdentifierCodec.makeChildExecutionId({
        parentTurnId: invocation.executionId,
        childId: invocation.callId,
      }),
      address_id: addressId,
      input: [
        Content.text(
          profile === "ReadThread" && threadId !== undefined
            ? `Current thread ID: ${threadId}\n\n${requestedPrompt}`
            : requestedPrompt,
        ),
      ],
      preset_name: `${profile}:${childDepth}`,
      metadata: {
        product_profile: profile,
        steering_enabled: true,
        rika_agent_depth: childDepth,
        rika_permissions: [...childPreset.permissions],
        rika_reasoning_effort: childRoute.effort,
        ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
        rika_execution_route: durableRoute,
      },
    }
    yield* client.childRuns
      .spawn({ execution_id: parentExecutionId, ...child, wait: true })
      .pipe(
        Effect.mapError((cause) =>
          AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
        ),
      )
    yield* Effect.logInfo("delegation.spawned").pipe(
      Effect.annotateLogs({
        "rika.execution.id": invocation.executionId,
        "rika.child.execution.id": String(child.child_execution_id),
        "rika.tool.name": toolName,
      }),
    )
    return AgentTools.AgentContract.spawned({ childExecutionId: String(child.child_execution_id) })
  })
  const delegationHandlerLayer = AgentToolkits.AgentContract.modelToolkit.toLayer({
    task: (delegationInput) => delegation("task", "Task", delegationInput),
    oracle: (delegationInput) => delegation("oracle", "Oracle", delegationInput),
    librarian: (delegationInput) => delegation("librarian", "Librarian", delegationInput),
    review: (delegationInput) => delegation("review", "Review", delegationInput),
    surgeon: (delegationInput) => delegation("surgeon", "Surgeon", delegationInput),
    read_thread: (delegationInput) => delegation("read_thread", "ReadThread", delegationInput),
  })
  return {
    toolkit,
    runnerToolkit,
    handlerLayer: Layer.mergeAll(
      options.additionalHandlerLayer === undefined
        ? ToolCatalog.handlerLayer
        : Layer.merge(ToolCatalog.handlerLayer, options.additionalHandlerLayer),
      handlerLayer(promoterRegistry),
      delegationHandlerLayer,
    ),
    parentPermissions,
  }
}
