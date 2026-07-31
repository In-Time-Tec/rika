import { Content } from "@relayfx/sdk"
import type { Tool } from "effect/unstable/ai"
import { Effect, Schema } from "effect"
import type { InvokeChildInput } from "@rika/product/execution-child-run"
import { BackendError } from "@rika/product/execution-service"
import * as Mapping from "./relay-event-mapping"
import * as Identifier from "./relay-execution-identifier"
import * as ModelRouting from "../../model/routing/relay-model-registry"
import { resolve, resolveTitle } from "../../agent/definition/baton-agent-definition"
import type { ChildExecutionMethodsInput } from "./relay-child-execution-context"

export const childInvocationMethods = <AdditionalTools extends Record<string, Tool.Any>>(
  input: ChildExecutionMethodsInput<AdditionalTools>,
) => {
  const { client, options, context } = input
  return {
    invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (child: InvokeChildInput) {
      const parentExecutionId = Identifier.executionId({ turnId: child.parentTurnId, reference: undefined })
      const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(Mapping.error))
      const routePin = parent === undefined ? undefined : Identifier.decodeExecutionRouteMetadata(parent.metadata)
      if (parent === undefined || routePin === undefined)
        return yield* BackendError.make({ message: `Execution ${child.parentTurnId} has no pinned model route` })
      const route =
        child.profile === "Title"
          ? routePin.title
          : ModelRouting.routeForProfile({ pin: routePin, profile: child.profile })
      if (route === undefined)
        return yield* BackendError.make({ message: `Execution ${child.parentTurnId} has no pinned title route` })
      const preset =
        child.profile === "Title"
          ? resolveTitle(ModelRouting.pinnedSelection(route))
          : resolve(child.profile, ModelRouting.pinnedSelection(route)).preset
      const depth = context.childExecutionDepth(String(parentExecutionId)) + 1
      const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(Effect.mapError(Mapping.error))
      const threadId = Identifier.threadIdFromMetadata(parent.metadata)
      yield* client.childRuns
        .spawn({
          execution_id: parentExecutionId,
          child_execution_id: Identifier.makeChildExecutionId({
            parentTurnId: child.parentTurnId,
            childId: child.childId,
          }),
          address_id: context.addressId,
          input: [Content.text(child.prompt)],
          instructions: preset.instructions,
          model: {
            ...preset.model,
            metadata: {
              rika_execution_route: durableRoute,
              rika_agent_depth: depth,
              rika_reasoning_effort: route.effort,
              ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
            },
          },
          tool_names:
            child.profile === "Title"
              ? []
              : ModelRouting.availableTools({
                  options,
                  names: context.toolsAtDepth(preset.tool_names, depth),
                }),
          permissions: preset.permissions,
          ...(child.profile === "Title"
            ? {}
            : {
                compaction_policy: ModelRouting.pinnedCompactionPolicy({
                  route,
                  summaryModel: routePin.compactionSummary,
                }),
              }),
          metadata: {
            product_profile: child.profile,
            steering_enabled: true,
            rika_agent_depth: depth,
            rika_permissions: [...preset.permissions],
            rika_reasoning_effort: route.effort,
            ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
            rika_execution_route: durableRoute,
          },
          wait: false,
        })
        .pipe(Effect.mapError(Mapping.error))
      return {
        parentTurnId: child.parentTurnId,
        childId: child.childId,
        profile: child.profile,
        type: "accepted" as const,
      }
    }),
  }
}
