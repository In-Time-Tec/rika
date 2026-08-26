import * as ExecutionProjection from "../../../execution/projection/contract"
import * as ThreadView from "@rika/product/thread-view"

interface InputTokenDifference {
  total?: number
  uncached?: number
  cacheRead?: number
  cacheWrite?: number
}

interface OutputTokenDifference {
  total?: number
  text?: number
  reasoning?: number
}

interface TokenDifference {
  total?: number
  input: InputTokenDifference
  output: OutputTokenDifference
  failedProviderTotal?: number
}

const difference = (next: number | undefined, previous: number | undefined): number | undefined => {
  if (next === undefined) return previous === undefined ? undefined : 0
  return Math.max(0, next - (previous ?? 0))
}

const tokenDifference = (
  next: ExecutionProjection.TokenTotals | undefined,
  previous: ExecutionProjection.TokenTotals | undefined,
): ExecutionProjection.TokenTotals | undefined => {
  if (next === undefined) return undefined
  const input: InputTokenDifference = {}
  const output: OutputTokenDifference = {}
  const tokens: TokenDifference = { input, output }
  const total = difference(next.total, previous?.total)
  const inputTotal = difference(next.input.total, previous?.input.total)
  const uncached = difference(next.input.uncached, previous?.input.uncached)
  const cacheRead = difference(next.input.cacheRead, previous?.input.cacheRead)
  const cacheWrite = difference(next.input.cacheWrite, previous?.input.cacheWrite)
  const outputTotal = difference(next.output.total, previous?.output.total)
  const text = difference(next.output.text, previous?.output.text)
  const reasoning = difference(next.output.reasoning, previous?.output.reasoning)
  const failedProviderTotal = difference(next.failedProviderTotal, previous?.failedProviderTotal)
  if (total !== undefined) tokens.total = total
  if (inputTotal !== undefined) input.total = inputTotal
  if (uncached !== undefined) input.uncached = uncached
  if (cacheRead !== undefined) input.cacheRead = cacheRead
  if (cacheWrite !== undefined) input.cacheWrite = cacheWrite
  if (outputTotal !== undefined) output.total = outputTotal
  if (text !== undefined) output.text = text
  if (reasoning !== undefined) output.reasoning = reasoning
  if (failedProviderTotal !== undefined) tokens.failedProviderTotal = failedProviderTotal
  return tokens
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
    const tokens = tokenDifference(next.tokens, previous?.tokens)
    const deltaBase = {
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
    } satisfies ExecutionProjection.UsageState
    let delta: ExecutionProjection.UsageState
    if (costNanoUsd === undefined) {
      if (tokens === undefined) delta = deltaBase
      else delta = { ...deltaBase, tokens }
    } else if (tokens === undefined) delta = { ...deltaBase, costNanoUsd }
    else delta = { ...deltaBase, costNanoUsd, tokens }
    const aggregate = ExecutionProjection.aggregateUsage([current.state, delta])
    const context = next.context ?? current.state.context
    let active: ExecutionProjection.UsageState["active"]
    if (aggregate.active._tag === "Unavailable") active = aggregate.active
    else if (next.active._tag === "Available" && next.active.activeSince !== undefined)
      active = {
        _tag: "Available",
        accumulatedMillis: aggregate.active.accumulatedMillis,
        activeSince: next.active.activeSince,
      }
    else active = { _tag: "Available", accumulatedMillis: aggregate.active.accumulatedMillis }
    let contextCapacity = current.contextCapacity
    if (next.context !== undefined && turn?._tag === "AgentExecution")
      contextCapacity = {
        contextWindow: turn.executionRoute.main.compaction.contextWindow,
        reserveTokens: turn.executionRoute.main.compaction.reserveTokens,
      }
    const stateBase = {
      ...aggregate,
      sourceComplete: next.sourceComplete,
      contextPending: next.contextPending,
      active,
    }
    const state: ExecutionProjection.UsageState = context === undefined ? stateBase : { ...stateBase, context }
    return contextCapacity === undefined ? { state } : { state, contextCapacity }
  },
}
