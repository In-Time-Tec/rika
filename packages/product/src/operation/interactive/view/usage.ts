import * as ExecutionProjection from "../../../execution/contract/execution-projection"
import * as ThreadView from "@rika/product/thread-view"

const difference = (next: number | undefined, previous: number | undefined): number | undefined => {
  if (next === undefined) return previous === undefined ? undefined : 0
  return Math.max(0, next - (previous ?? 0))
}

const tokenDifference = (
  next: ExecutionProjection.TokenTotals | undefined,
  previous: ExecutionProjection.TokenTotals | undefined,
): ExecutionProjection.TokenTotals | undefined => {
  if (next === undefined) return undefined
  return {
    ...(difference(next.total, previous?.total) === undefined
      ? {}
      : { total: difference(next.total, previous?.total)! }),
    input: {
      ...(difference(next.input.total, previous?.input.total) === undefined
        ? {}
        : { total: difference(next.input.total, previous?.input.total)! }),
      ...(difference(next.input.uncached, previous?.input.uncached) === undefined
        ? {}
        : { uncached: difference(next.input.uncached, previous?.input.uncached)! }),
      ...(difference(next.input.cacheRead, previous?.input.cacheRead) === undefined
        ? {}
        : { cacheRead: difference(next.input.cacheRead, previous?.input.cacheRead)! }),
      ...(difference(next.input.cacheWrite, previous?.input.cacheWrite) === undefined
        ? {}
        : { cacheWrite: difference(next.input.cacheWrite, previous?.input.cacheWrite)! }),
    },
    output: {
      ...(difference(next.output.total, previous?.output.total) === undefined
        ? {}
        : { total: difference(next.output.total, previous?.output.total)! }),
      ...(difference(next.output.text, previous?.output.text) === undefined
        ? {}
        : { text: difference(next.output.text, previous?.output.text)! }),
      ...(difference(next.output.reasoning, previous?.output.reasoning) === undefined
        ? {}
        : { reasoning: difference(next.output.reasoning, previous?.output.reasoning)! }),
    },
    ...(difference(next.failedProviderTotal, previous?.failedProviderTotal) === undefined
      ? {}
      : { failedProviderTotal: difference(next.failedProviderTotal, previous?.failedProviderTotal)! }),
  }
}

export const threadUsage = {
  next: (
    current: ThreadView.ThreadViewUsage,
    previous: ExecutionProjection.UsageState | undefined,
    next: ExecutionProjection.UsageState,
    turn: import("@rika/product/turn-record").Turn | undefined,
  ): ThreadView.ThreadViewUsage => {
    const previousActive = previous?.active._tag === "Available" ? previous.active.accumulatedMillis : 0
    const nextActive = next.active._tag === "Available" ? next.active.accumulatedMillis : 0
    const costNanoUsd = difference(next.costNanoUsd, previous?.costNanoUsd)
    const delta: ExecutionProjection.UsageState = {
      ...(costNanoUsd === undefined ? {} : { costNanoUsd }),
      ...(tokenDifference(next.tokens, previous?.tokens) === undefined
        ? {}
        : { tokens: tokenDifference(next.tokens, previous?.tokens)! }),
      pricedAttempts: Math.max(0, next.pricedAttempts - (previous?.pricedAttempts ?? 0)),
      unpricedAttempts: Math.max(0, next.unpricedAttempts - (previous?.unpricedAttempts ?? 0)),
      includedAttempts: Math.max(0, (next.includedAttempts ?? 0) - (previous?.includedAttempts ?? 0)),
      countedAttempts: Math.max(0, next.countedAttempts - (previous?.countedAttempts ?? 0)),
      uncountedAttempts: Math.max(0, next.uncountedAttempts - (previous?.uncountedAttempts ?? 0)),
      sourceComplete: next.sourceComplete,
      contextPending: next.contextPending,
      active:
        next.active._tag === "Unavailable"
          ? { _tag: "Unavailable" }
          : { _tag: "Available", accumulatedMillis: Math.max(0, nextActive - previousActive) },
    }
    const aggregate = ExecutionProjection.aggregateUsage([current.state, delta])
    const context = next.context ?? current.state.context
    const active =
      aggregate.active._tag === "Unavailable"
        ? aggregate.active
        : {
            _tag: "Available" as const,
            accumulatedMillis: aggregate.active.accumulatedMillis,
            ...(next.active._tag === "Available" && next.active.activeSince !== undefined
              ? { activeSince: next.active.activeSince }
              : {}),
          }
    let contextCapacity = current.contextCapacity
    if (next.context !== undefined && turn?._tag === "AgentExecution")
      contextCapacity = {
        contextWindow: turn.executionRoute.main.compaction.contextWindow,
        reserveTokens: turn.executionRoute.main.compaction.reserveTokens,
      }
    return {
      state: {
        ...aggregate,
        sourceComplete: next.sourceComplete,
        ...(context === undefined ? {} : { context }),
        contextPending: next.contextPending,
        active,
      },
      ...(contextCapacity === undefined ? {} : { contextCapacity }),
    }
  },
}
