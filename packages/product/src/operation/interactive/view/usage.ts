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

const defined = <A extends object, K extends string, V>(target: A, key: K, value: V | undefined): void => {
  if (value !== undefined) Object.assign(target, { [key]: value })
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
  defined(tokens, "total", total)
  defined(input, "total", inputTotal)
  defined(input, "uncached", uncached)
  defined(input, "cacheRead", cacheRead)
  defined(input, "cacheWrite", cacheWrite)
  defined(output, "total", outputTotal)
  defined(output, "text", text)
  defined(output, "reasoning", reasoning)
  defined(tokens, "failedProviderTotal", failedProviderTotal)
  return tokens
}

const usageDelta = (
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
): ExecutionProjection.UsageState => {
  const prior = previous ?? ExecutionProjection.emptyUsageState()
  const previousActive = prior.active._tag === "Available" ? prior.active.accumulatedMillis : 0
  const nextActive = next.active._tag === "Available" ? next.active.accumulatedMillis : 0
  const costNanoUsd = difference(next.costNanoUsd, prior.costNanoUsd)
  const tokens = tokenDifference(next.tokens, prior.tokens)
  const delta: ExecutionProjection.UsageState = {
    pricedAttempts: Math.max(0, next.pricedAttempts - prior.pricedAttempts),
    unpricedAttempts: Math.max(0, next.unpricedAttempts - prior.unpricedAttempts),
    includedAttempts: Math.max(0, (next.includedAttempts ?? 0) - (prior.includedAttempts ?? 0)),
    countedAttempts: Math.max(0, next.countedAttempts - prior.countedAttempts),
    uncountedAttempts: Math.max(0, next.uncountedAttempts - prior.uncountedAttempts),
    sourceComplete: next.sourceComplete,
    contextPending: next.contextPending,
    active:
      next.active._tag === "Unavailable"
        ? { _tag: "Unavailable" }
        : { _tag: "Available", accumulatedMillis: Math.max(0, nextActive - previousActive) },
  }
  defined(delta, "costNanoUsd", costNanoUsd)
  defined(delta, "tokens", tokens)
  return delta
}

const currentActive = (
  aggregate: ExecutionProjection.UsageState,
  next: ExecutionProjection.UsageState,
): ExecutionProjection.UsageState["active"] => {
  if (aggregate.active._tag === "Unavailable") return aggregate.active
  return next.active._tag === "Available" && next.active.activeSince !== undefined
    ? { _tag: "Available", accumulatedMillis: aggregate.active.accumulatedMillis, activeSince: next.active.activeSince }
    : { _tag: "Available", accumulatedMillis: aggregate.active.accumulatedMillis }
}

export const threadUsage = {
  next: (
    current: ThreadView.ThreadViewUsage,
    previous: ExecutionProjection.UsageState | undefined,
    next: ExecutionProjection.UsageState,
    turn: import("@rika/product/turn-record").Turn | undefined,
  ): ThreadView.ThreadViewUsage => {
    const aggregate = ExecutionProjection.aggregateUsage([current.state, usageDelta(previous, next)])
    const context = next.context ?? current.state.context
    const active = currentActive(aggregate, next)
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
