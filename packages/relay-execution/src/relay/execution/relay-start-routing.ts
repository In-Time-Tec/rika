import { ModelRegistry } from "@batonfx/core"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { AgentProfile } from "@rika/product/execution-child-run"
import type { StartInput } from "@rika/product/execution-request"
import type { StartOptions } from "./relay-execution-start-method"
import {
  agentSelections,
  pinnedSelection,
  routeForProfile,
  usesMainRoute,
  variantSelection,
} from "../../model/routing/relay-model-selection"
import { availableTools, toolkitFor } from "../../model/routing/relay-model-tools"
import { compactionPolicy, pinnedCompactionPolicy } from "../../model/routing/relay-model-compaction"
import { mainInstructions, presets } from "../../agent/definition/baton-agent-definition"
import { toolsAtDepth } from "../../agent-depth"

type StartRoutingOptions<AdditionalTools extends Record<string, Tool.Any>> = StartOptions<AdditionalTools>

export const rootInstructions = mainInstructions

export const rootTools = <AdditionalTools extends Record<string, Tool.Any>>(
  options: StartRoutingOptions<AdditionalTools>,
) =>
  Object.values(toolkitFor(options).tools)
    .filter((tool) => tool.name !== "search_threads" && tool.name !== "read_thread_transcript")
    .map((tool) => ({ name: tool.name }))

export const childPresets = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly options: StartRoutingOptions<AdditionalTools>
  readonly start: StartInput
  readonly selection: ModelRegistry.ModelSelection
  readonly oracleSelection: ModelRegistry.ModelSelection | undefined
  readonly durableRoute: Schema.Json
}) =>
  Object.fromEntries(
    [1, 2].flatMap((childDepth) =>
      Object.entries(
        presets({
          model: input.selection,
          oracleModel: input.oracleSelection,
          ...(input.options.modelVariantPolicy === "fixed-selection"
            ? {}
            : { agentModels: agentSelections(input.start.executionRoute) }),
        }),
      ).map(([name, preset]) => {
        const profile = name as AgentProfile
        const mainRoute = usesMainRoute(profile)
        const profileRoute = routeForProfile({ pin: input.start.executionRoute, profile })
        const effort = mainRoute
          ? (input.start.reasoningEffort ?? input.start.executionRoute.main.effort)
          : profileRoute.effort
        const policy =
          input.options.modelVariantPolicy === "fixed-selection"
            ? compactionPolicy({
                compaction: mainRoute
                  ? input.options.compaction
                  : (input.options.oracleCompaction ?? input.options.compaction),
                summaryModel: input.options.compactionSummarySelection,
              })
            : pinnedCompactionPolicy({
                route: profileRoute,
                summaryModel: input.start.executionRoute.compactionSummary,
              })
        return [
          `${name}:${childDepth}`,
          {
            ...preset,
            model: {
              ...preset.model,
              metadata: {
                rika_execution_route: input.durableRoute,
                rika_thread_id: input.start.threadId,
                rika_agent_depth: childDepth,
                rika_reasoning_effort: effort,
              },
            },
            tool_names: availableTools({ options: input.options, names: toolsAtDepth(preset.tool_names, childDepth) }),
            ...(policy === undefined ? {} : { compaction_policy: policy }),
            metadata: {
              ...preset.metadata,
              steering_enabled: true,
              rika_thread_id: input.start.threadId,
              rika_agent_depth: childDepth,
              rika_reasoning_effort: effort,
              rika_execution_route: input.durableRoute,
            },
          },
        ]
      }),
    ),
  )

export const rootModel = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly options: StartRoutingOptions<AdditionalTools>
  readonly start: StartInput
}) => {
  const rootCompaction =
    input.options.modelVariantPolicy === "fixed-selection"
      ? compactionPolicy({
          compaction: input.options.compaction,
          summaryModel: input.options.compactionSummarySelection,
        })
      : pinnedCompactionPolicy({
          route: input.start.executionRoute.main,
          summaryModel: input.start.executionRoute.compactionSummary,
        })
  const selection =
    input.options.modelVariantPolicy === "fixed-selection"
      ? variantSelection({
          selection: input.options.selection,
          effort: input.start.reasoningEffort ?? input.options.defaultReasoningEffort,
          fast: input.start.fastMode === true,
          policy: input.options.modelVariantPolicy ?? "registration-key",
        })
      : pinnedSelection(input.start.executionRoute.main)
  const oracleSelection =
    input.options.modelVariantPolicy === "fixed-selection"
      ? input.options.oracleSelection
      : pinnedSelection(input.start.executionRoute.oracle)
  return { rootCompaction, selection, oracleSelection }
}
