import { Content, Ids } from "@relayfx/sdk"
import type { Tool } from "effect/unstable/ai"
import { Effect, Schema } from "effect"
import type { FanOutInput } from "@rika/product/execution-child-run"
import * as Mapping from "./relay-event-mapping"
import * as Identifier from "./relay-execution-identifier"
import * as ModelRouting from "../../model/routing/relay-model-registry"
import { resolve } from "../../agent/definition/baton-agent-definition"
import type { ChildExecutionMethodsInput } from "./relay-child-execution-context"

export const fanOutMethods = <AdditionalTools extends Record<string, Tool.Any>>(
  input: ChildExecutionMethodsInput<AdditionalTools>,
) => {
  const { client, options, context } = input
  return {
    createFanOut: Effect.fn("ExecutionBackend.createFanOut")((fanOut: FanOutInput) =>
      Effect.gen(function* () {
        const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(fanOut.executionRoute)
        const parentExecutionId = Identifier.executionId({ turnId: fanOut.parentTurnId, reference: undefined })
        const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(Mapping.error))
        const threadId = Identifier.threadIdFromMetadata(parent?.metadata)
        const depth = context.childExecutionDepth(String(parentExecutionId)) + 1
        const children = yield* Effect.forEach(fanOut.children, (child) => {
          const profile = child.profile ?? "Task"
          const profileRoute = ModelRouting.routeForProfile({ pin: fanOut.executionRoute, profile })
          const mainRoute = ModelRouting.usesMainRoute(profile)
          const selected = (() => {
            if (options.modelVariantPolicy !== "fixed-selection") return ModelRouting.pinnedSelection(profileRoute)
            if (mainRoute) return options.selection
            return options.oracleSelection ?? options.selection
          })()
          const preset = resolve(profile, selected).preset
          const policy =
            options.modelVariantPolicy === "fixed-selection"
              ? ModelRouting.compactionPolicy({
                  compaction: mainRoute ? options.compaction : (options.oracleCompaction ?? options.compaction),
                  summaryModel: options.compactionSummarySelection,
                })
              : ModelRouting.pinnedCompactionPolicy({
                  route: profileRoute,
                  summaryModel: fanOut.executionRoute?.compactionSummary,
                })
          return Effect.succeed({
            child_execution_id: Identifier.makeChildExecutionId({
              parentTurnId: fanOut.parentTurnId,
              childId: child.childId,
            }),
            address_id: context.addressId,
            input: [Content.text(child.prompt)],
            override: {
              ...preset,
              model: {
                ...preset.model,
                metadata: {
                  rika_execution_route: durableRoute,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: profileRoute.effort,
                },
              },
              tool_names: ModelRouting.availableTools({
                options,
                names: context.toolsAtDepth(preset.tool_names, depth),
              }),
              ...(policy === undefined ? {} : { compaction_policy: policy }),
            },
            metadata: {
              product_profile: profile,
              steering_enabled: true,
              rika_agent_depth: depth,
              rika_reasoning_effort: profileRoute.effort,
              ...(fanOut.workspace === undefined ? {} : { rika_workspace: fanOut.workspace }),
              ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
              rika_execution_route: durableRoute,
            },
          })
        })
        const state = yield* client.childRuns.createFanOut({
          fan_out_id: Ids.ChildFanOutId.make(fanOut.fanOutId),
          parent_execution_id: parentExecutionId,
          children,
          max_concurrency: fanOut.maxConcurrency,
          join:
            fanOut.join === "quorum"
              ? { _tag: "quorum", count: fanOut.quorum ?? fanOut.children.length }
              : { _tag: fanOut.join },
          created_at: fanOut.createdAt,
        })
        return Mapping.mapFanOut(state)
      }).pipe(Effect.mapError(Mapping.error)),
    ),
    inspectFanOut: Effect.fn("ExecutionBackend.inspectFanOut")(function* (fanOutId: string) {
      const result = yield* client.childRuns
        .inspectFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
        .pipe(Effect.mapError(Mapping.error))
      return result.fan_out === null ? undefined : Mapping.mapFanOut(result.fan_out)
    }),
    cancelFanOut: Effect.fn("ExecutionBackend.cancelFanOut")(function* (
      fanOutId: string,
      cancelledAt: number,
      reason: string | undefined,
    ) {
      const result = yield* client.childRuns
        .cancelFanOut({
          fan_out_id: Ids.ChildFanOutId.make(fanOutId),
          cancelled_at: cancelledAt,
          ...(reason === undefined ? {} : { reason }),
        })
        .pipe(Effect.mapError(Mapping.error))
      return Mapping.mapFanOut(result.fan_out)
    }),
  }
}
