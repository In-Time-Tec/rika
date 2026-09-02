import type { Run, RunEvent } from "generalist/runtime"
import * as Projection from "@rika/product/execution-projection"
import type { ModelCallState, Node } from "./model"
import { add, occurredAt, providerCostNanoUsd, token } from "./decoding"

export interface UsageAccounting {
  readonly modelCalls: Map<string, ModelCallState>
  readonly usage: () => Projection.UsageState
  readonly activeTime: () => Projection.ActiveTime
  readonly contextPending: () => boolean
  readonly nextRequestOrdinal: () => number
  readonly requestOrdinal: () => number
  readonly pendingContextOrdinal: () => number | undefined
  readonly awaitContext: (ordinal: number | undefined) => void
  readonly observeLifecycleAt: (event: RunEvent.RunEvent) => number
  readonly activate: (node: Node, event: RunEvent.RunEvent) => void
  readonly deactivate: (node: Node, event: RunEvent.RunEvent, next: "waiting" | "terminal") => void
  readonly settleCalls: (node: Node) => void
  readonly replaceFacts: (rootRunId: string, facts: ReadonlyArray<Run.RawUsageFact>) => void
}

const setDefined = <A extends object, K extends PropertyKey, V>(target: A, key: K, value: V | undefined): void => {
  if (value !== undefined) Object.assign(target, { [key]: value })
}

interface FactTotals {
  readonly inputTotal: number | undefined
  readonly inputUncached: number | undefined
  readonly inputCacheRead: number | undefined
  readonly inputCacheWrite: number | undefined
  readonly outputTotal: number | undefined
  readonly outputText: number | undefined
  readonly outputReasoning: number | undefined
  readonly failedProviderTotal: number | undefined
  readonly attemptTotal: number | undefined
}

const factTotals = (fact: Run.RawUsageFact): FactTotals => {
  const inputTotal = token(fact._tag === "Completed" ? fact.usage.inputTokens.total : fact.providerUsage.inputTokens)
  const outputTotal = token(fact._tag === "Completed" ? fact.usage.outputTokens.total : fact.providerUsage.outputTokens)
  const failedProviderTotal = token(fact._tag === "Failed" ? fact.providerUsage.totalTokens : undefined)
  return {
    inputTotal,
    inputUncached: token(fact._tag === "Completed" ? fact.usage.inputTokens.uncached : undefined),
    inputCacheRead: token(fact._tag === "Completed" ? fact.usage.inputTokens.cacheRead : undefined),
    inputCacheWrite: token(fact._tag === "Completed" ? fact.usage.inputTokens.cacheWrite : undefined),
    outputTotal,
    outputText: token(fact._tag === "Completed" ? fact.usage.outputTokens.text : undefined),
    outputReasoning: token(fact._tag === "Completed" ? fact.usage.outputTokens.reasoning : undefined),
    failedProviderTotal,
    attemptTotal:
      failedProviderTotal ??
      (inputTotal === undefined || outputTotal === undefined ? undefined : inputTotal + outputTotal),
  }
}

const addFactTokens = (state: Projection.UsageState, totals: FactTotals): void => {
  const current = state.tokens
  const input: Projection.TokenTotals["input"] = {}
  const output: Projection.TokenTotals["output"] = {}
  setDefined(input, "total", add(current?.input.total, totals.inputTotal))
  setDefined(input, "uncached", add(current?.input.uncached, totals.inputUncached))
  setDefined(input, "cacheRead", add(current?.input.cacheRead, totals.inputCacheRead))
  setDefined(input, "cacheWrite", add(current?.input.cacheWrite, totals.inputCacheWrite))
  setDefined(output, "total", add(current?.output.total, totals.outputTotal))
  setDefined(output, "text", add(current?.output.text, totals.outputText))
  setDefined(output, "reasoning", add(current?.output.reasoning, totals.outputReasoning))
  const next: Projection.TokenTotals = { input, output }
  setDefined(next, "total", add(current?.total, totals.attemptTotal))
  setDefined(next, "failedProviderTotal", add(current?.failedProviderTotal, totals.failedProviderTotal))
  if (Object.keys(input).length > 0 || Object.keys(output).length > 0 || next.total !== undefined)
    Object.assign(state, { tokens: next })
}

const accountFact = (
  state: Projection.UsageState,
  fact: Run.RawUsageFact,
  attemptTotal: number | undefined,
  pricing: "included" | "metered",
): void => {
  Object.assign(
    state,
    attemptTotal === undefined
      ? { uncountedAttempts: state.uncountedAttempts + 1 }
      : { countedAttempts: state.countedAttempts + 1 },
  )
  if (pricing === "included") {
    Object.assign(state, { includedAttempts: (state.includedAttempts ?? 0) + 1 })
    return
  }
  const cost = providerCostNanoUsd(fact)
  if (cost === undefined) {
    Object.assign(state, { unpricedAttempts: state.unpricedAttempts + 1 })
    return
  }
  const costNanoUsd = add(state.costNanoUsd, cost)
  if (costNanoUsd !== undefined) Object.assign(state, { costNanoUsd, pricedAttempts: state.pricedAttempts + 1 })
}

const contextFrom = (
  rootRunId: string,
  fact: Run.RawUsageFact,
  inputTokens: number | undefined,
): Projection.UsageState["context"] => {
  if (fact._tag !== "Completed" || fact.runId !== rootRunId || fact.purpose !== "conversation") return undefined
  return inputTokens === undefined ? undefined : { requestOrdinal: fact.turn + 1, purpose: "conversation", inputTokens }
}

export const makeUsageAccounting = (pricing: "included" | "metered" = "metered"): UsageAccounting => {
  let usageState = Projection.emptyUsageState()
  let requestOrdinal = 0
  let pendingContextOrdinal: number | undefined
  const modelCalls = new Map<string, ModelCallState>()
  let activeAvailable = false
  let activeDepth = 0
  let activeAccumulatedMillis = 0
  let activeSince: number | undefined
  let lastLifecycleAt: number | undefined

  const observeLifecycleAt = (event: RunEvent.RunEvent): number => {
    const at = occurredAt(event)
    if (lastLifecycleAt !== undefined && at < lastLifecycleAt)
      throw new TypeError(`Generalist lifecycle timestamp regressed: ${event.eventId}`)
    lastLifecycleAt = at
    return at
  }

  const activate = (node: Node, event: RunEvent.RunEvent) => {
    const at = observeLifecycleAt(event)
    if (node.lifecycle === "active") throw new TypeError(`Generalist Run ${node.rawRunId} activated twice`)
    if (node.lifecycle === "terminal") throw new TypeError(`Generalist Run ${node.rawRunId} activated after terminal`)
    if (activeDepth === 0) activeSince = at
    activeDepth += 1
    activeAvailable = true
    node.lifecycle = "active"
  }

  const deactivate = (node: Node, event: RunEvent.RunEvent, next: "waiting" | "terminal") => {
    const at = observeLifecycleAt(event)
    if (node.lifecycle === "active") {
      if (activeDepth <= 0 || activeSince === undefined) throw new TypeError("Invalid Generalist active-time depth")
      activeDepth -= 1
      if (activeDepth === 0) {
        activeAccumulatedMillis += at - activeSince
        activeSince = undefined
      }
    } else if (next === "waiting" && node.lifecycle !== "unknown" && node.lifecycle !== "accepted")
      throw new TypeError(`Generalist Run ${node.rawRunId} waited while ${node.lifecycle}`)
    else if (next === "terminal" && node.lifecycle === "terminal")
      throw new TypeError(`Generalist Run ${node.rawRunId} settled twice`)
    node.lifecycle = next
  }

  const replaceFacts = (rootRunId: string, facts: ReadonlyArray<Run.RawUsageFact>) => {
    const next = Projection.emptyUsageState()
    let context: Projection.UsageState["context"]
    const seen = new Set<string>()
    for (const fact of facts) {
      const key = `${fact.runId}\u0000${fact.modelAttemptId}`
      if (seen.has(key)) throw new TypeError(`Generalist checkpoint contains duplicate usage fact: ${key}`)
      seen.add(key)
      const totals = factTotals(fact)
      addFactTokens(next, totals)
      accountFact(next, fact, totals.attemptTotal, pricing)
      const candidate = contextFrom(rootRunId, fact, totals.inputTotal)
      if (candidate !== undefined && (context === undefined || candidate.requestOrdinal >= context.requestOrdinal))
        context = candidate
    }
    if (context !== undefined) {
      Object.assign(next, { context })
      requestOrdinal = Math.max(requestOrdinal, context.requestOrdinal)
      if (pendingContextOrdinal !== undefined && pendingContextOrdinal <= context.requestOrdinal)
        pendingContextOrdinal = undefined
    }
    usageState = next
  }

  return {
    modelCalls,
    usage: () => usageState,
    activeTime: () => {
      if (!activeAvailable) return { _tag: "Unavailable" }
      const activeTime: Projection.ActiveTime = { _tag: "Available", accumulatedMillis: activeAccumulatedMillis }
      if (activeSince !== undefined) Object.assign(activeTime, { activeSince })
      return activeTime
    },
    contextPending: () => pendingContextOrdinal !== undefined,
    nextRequestOrdinal: () => {
      requestOrdinal += 1
      return requestOrdinal
    },
    requestOrdinal: () => requestOrdinal,
    pendingContextOrdinal: () => pendingContextOrdinal,
    awaitContext: (ordinal) => {
      pendingContextOrdinal = ordinal
    },
    observeLifecycleAt,
    activate,
    deactivate,
    settleCalls: (node) => {
      for (const [key, call] of modelCalls) {
        if (!key.startsWith(`${node.rawRunId}\u0000`)) continue
        if (call.requestOrdinal === pendingContextOrdinal) pendingContextOrdinal = undefined
        modelCalls.delete(key)
      }
    },
    replaceFacts,
  }
}
