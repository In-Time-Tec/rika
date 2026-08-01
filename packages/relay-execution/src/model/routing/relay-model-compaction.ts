import { ModelRegistry } from "@batonfx/core"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import { pinnedSelection, relayModelSelection } from "./relay-model-selection"

export const pinnedCompactionPolicy = (input: {
  readonly route: ExecutionRoutePin["main"]
  readonly summaryModel: ExecutionRoutePin["compactionSummary"] | undefined
}) => ({
  context_window: input.route.compaction.contextWindow,
  reserve_tokens: input.route.compaction.reserveTokens,
  keep_recent_tokens: input.route.compaction.keepRecentTokens,
  ...(input.summaryModel === undefined
    ? {}
    : { summary_model: relayModelSelection(pinnedSelection(input.summaryModel)) }),
})

export const compactionPolicy = (input: {
  readonly compaction:
    | { readonly contextWindow?: number; readonly reserveTokens?: number; readonly keepRecentTokens?: number }
    | undefined
  readonly summaryModel: ModelRegistry.ModelSelection | undefined
}) =>
  input.compaction?.contextWindow === undefined ||
  input.compaction.reserveTokens === undefined ||
  input.compaction.keepRecentTokens === undefined
    ? undefined
    : {
        context_window: input.compaction.contextWindow,
        reserve_tokens: input.compaction.reserveTokens,
        keep_recent_tokens: input.compaction.keepRecentTokens,
        ...(input.summaryModel === undefined ? {} : { summary_model: relayModelSelection(input.summaryModel) }),
      }
