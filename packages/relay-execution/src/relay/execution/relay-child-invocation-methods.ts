import { error } from "./relay-event-payload"
import { pinnedSelection, routeForProfile } from "../../model/routing/relay-model-selection"
import { availableTools } from "../../model/routing/relay-model-tools"
import { pinnedCompactionPolicy } from "../../model/routing/relay-model-compaction"
import { Content } from "@relayfx/sdk"
import type { Tool } from "effect/unstable/ai"
import { Effect, Schema } from "effect"
import type { InvokeChildInput } from "@rika/product/execution-child-run"
import { BackendError } from "@rika/product/execution-service"
import * as Identifier from "./relay-execution-identifier"
import * as IdentifierCodec from "./relay-execution-id-codec"
import { resolve, resolveTitle } from "../../agent/definition/baton-agent-definition"
import type { ChildExecutionMethodsInput } from "./relay-child-execution-context"

export const childInvocationMethods = <AdditionalTools extends Record<string, Tool.Any>>(
  input: ChildExecutionMethodsInput<AdditionalTools>,
) => {
  const { client, options, context } = input
  return {
    invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (child: InvokeChildInput) {
      const parentExecutionId = IdentifierCodec.executionId({ turnId: child.parentTurnId, reference: undefined })
      const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(error))
      const routePin = parent === undefined ? undefined : IdentifierCodec.decodeExecutionRouteMetadata(parent.metadata)
      if (parent === undefined || routePin === undefined)
        return yield* BackendError.make({ message: `Execution ${child.parentTurnId} has no pinned model route` })
      const route =
        child.profile === "Title" ? routePin.title : routeForProfile({ pin: routePin, profile: child.profile })
      if (route === undefined)
        return yield* BackendError.make({ message: `Execution ${child.parentTurnId} has no pinned title route` })
      const preset =
        child.profile === "Title"
          ? resolveTitle(pinnedSelection(route))
          : resolve(child.profile, pinnedSelection(route)).preset
      const depth = context.childExecutionDepth(String(parentExecutionId)) + 1
      const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(Effect.mapError(error))
      const threadId = Identifier.threadIdFromMetadata(parent.metadata)
      yield* client.childRuns
        .spawn({
          execution_id: parentExecutionId,
          child_execution_id: IdentifierCodec.makeChildExecutionId({
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
              : availableTools({
                  options,
                  names: context.toolsAtDepth(preset.tool_names, depth),
                }),
          permissions: preset.permissions,
          ...(child.profile === "Title"
            ? {}
            : {
                compaction_policy: pinnedCompactionPolicy({
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
        .pipe(Effect.mapError(error))
      return {
        parentTurnId: child.parentTurnId,
        childId: child.childId,
        profile: child.profile,
        type: "accepted" as const,
      }
    }),
  }
}
