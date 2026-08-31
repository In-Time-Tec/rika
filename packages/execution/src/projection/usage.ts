import type { RunEvent } from "generalist/runtime"
import * as Projection from "@rika/product/execution-projection"
import type { Node } from "./model"
import type { AttemptStart, ModelCallState } from "./persistence"
import { add, occurredAt } from "./decoding"

export interface UsageAccounting {
  readonly attemptStarts: Map<string, AttemptStart>
  readonly settledAttemptKeys: Set<string>
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
  readonly recordAttempt: (input: RecordAttemptInput) => void
  readonly settleOpenAttempts: (node: Node) => void
  readonly persist: () => PersistedUsage
  readonly restore: (persisted: PersistedUsage) => void
}

export interface RecordAttemptInput {
  readonly key: string
  readonly node: Node
  readonly modelCallId: string
  readonly inputTotal?: number | undefined
  readonly inputUncached?: number | undefined
  readonly inputCacheRead?: number | undefined
  readonly inputCacheWrite?: number | undefined
  readonly outputTotal?: number | undefined
  readonly outputText?: number | undefined
  readonly outputReasoning?: number | undefined
  readonly failedProviderTotal?: number | undefined
  readonly costNanoUsd?: number | undefined
}

export interface PersistedUsage {
  readonly usageState: Projection.UsageState
  readonly requestOrdinal: number
  readonly pendingContextOrdinal?: number
  readonly attemptStarts: ReadonlyArray<readonly [string, AttemptStart]>
  readonly settledAttemptKeys: ReadonlyArray<string>
  readonly modelCalls: ReadonlyArray<readonly [string, ModelCallState]>
  readonly activeAvailable: boolean
  readonly activeDepth: number
  readonly activeAccumulatedMillis: number
  readonly activeSince?: number
  readonly lastLifecycleAt?: number
}

const setDefined = <A extends object, K extends PropertyKey, V>(target: A, key: K, value: V | undefined): void => {
  if (value !== undefined) Object.assign(target, { [key]: value })
}

export const makeUsageAccounting = (pricing: "included" | "metered" = "metered"): UsageAccounting => {
  let usageState = Projection.emptyUsageState()
  let requestOrdinal = 0
  let pendingContextOrdinal: number | undefined
  const attemptStarts = new Map<string, AttemptStart>()
  const settledAttemptKeys = new Set<string>()
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

  const addTokenTotals = (value: {
    readonly inputTotal?: number | undefined
    readonly inputUncached?: number | undefined
    readonly inputCacheRead?: number | undefined
    readonly inputCacheWrite?: number | undefined
    readonly outputTotal?: number | undefined
    readonly outputText?: number | undefined
    readonly outputReasoning?: number | undefined
    readonly failedProviderTotal?: number | undefined
    readonly attemptTotal?: number | undefined
  }) => {
    const current = usageState.tokens
    const total = add(current?.total, value.attemptTotal)
    const inputTotal = add(current?.input.total, value.inputTotal)
    const inputUncached = add(current?.input.uncached, value.inputUncached)
    const inputCacheRead = add(current?.input.cacheRead, value.inputCacheRead)
    const inputCacheWrite = add(current?.input.cacheWrite, value.inputCacheWrite)
    const outputTotal = add(current?.output.total, value.outputTotal)
    const outputText = add(current?.output.text, value.outputText)
    const outputReasoning = add(current?.output.reasoning, value.outputReasoning)
    const failedProviderTotal = add(current?.failedProviderTotal, value.failedProviderTotal)
    const input: Projection.TokenTotals["input"] = {}
    const output: Projection.TokenTotals["output"] = {}
    setDefined(input, "total", inputTotal)
    setDefined(input, "uncached", inputUncached)
    setDefined(input, "cacheRead", inputCacheRead)
    setDefined(input, "cacheWrite", inputCacheWrite)
    setDefined(output, "total", outputTotal)
    setDefined(output, "text", outputText)
    setDefined(output, "reasoning", outputReasoning)
    const next: Projection.TokenTotals = {
      input,
      output,
    }
    setDefined(next, "total", total)
    setDefined(next, "failedProviderTotal", failedProviderTotal)
    if (JSON.stringify(next) !== JSON.stringify({ input: {}, output: {} })) usageState = { ...usageState, tokens: next }
  }

  const rememberSettled = (key: string): boolean => {
    if (settledAttemptKeys.has(key)) return false
    settledAttemptKeys.add(key)
    while (settledAttemptKeys.size > Projection.limits.settledAttemptKeys)
      settledAttemptKeys.delete(settledAttemptKeys.values().next().value!)
    return true
  }

  const accountPrice = (cost: number | undefined) => {
    if (pricing === "included") {
      usageState = { ...usageState, includedAttempts: (usageState.includedAttempts ?? 0) + 1 }
      return
    }
    if (cost === undefined) {
      usageState = { ...usageState, unpricedAttempts: usageState.unpricedAttempts + 1 }
      return
    }
    const costNanoUsd = add(usageState.costNanoUsd, cost)
    if (costNanoUsd !== undefined)
      usageState = { ...usageState, costNanoUsd, pricedAttempts: usageState.pricedAttempts + 1 }
  }

  const recordAttempt = (input: {
    readonly key: string
    readonly node: Node
    readonly modelCallId: string
    readonly inputTotal?: number | undefined
    readonly inputUncached?: number | undefined
    readonly inputCacheRead?: number | undefined
    readonly inputCacheWrite?: number | undefined
    readonly outputTotal?: number | undefined
    readonly outputText?: number | undefined
    readonly outputReasoning?: number | undefined
    readonly failedProviderTotal?: number | undefined
    readonly costNanoUsd?: number | undefined
  }) => {
    if (!rememberSettled(input.key)) return
    const attemptTotal =
      input.failedProviderTotal ??
      (input.inputTotal === undefined || input.outputTotal === undefined
        ? undefined
        : input.inputTotal + input.outputTotal)
    addTokenTotals({ ...input, attemptTotal })
    accountPrice(input.costNanoUsd)
    usageState = {
      ...usageState,
      ...(attemptTotal === undefined
        ? { uncountedAttempts: usageState.uncountedAttempts + 1 }
        : { countedAttempts: usageState.countedAttempts + 1 }),
    }
    const call = modelCalls.get(`${input.node.rawRunId}\u0000${input.modelCallId}`)
    if (
      call?.requestOrdinal !== undefined &&
      call.purpose === "conversation" &&
      input.inputTotal !== undefined &&
      (usageState.context === undefined || call.requestOrdinal >= usageState.context.requestOrdinal)
    ) {
      usageState = {
        ...usageState,
        context: { requestOrdinal: call.requestOrdinal, purpose: "conversation", inputTokens: input.inputTotal },
      }
      if (pendingContextOrdinal === call.requestOrdinal) pendingContextOrdinal = undefined
    }
  }

  const settleOpenAttempts = (node: Node) => {
    for (const [key, attempt] of attemptStarts) {
      if (attempt.rawRunId !== node.rawRunId) continue
      recordAttempt({ key, node, modelCallId: attempt.modelCallId })
      attemptStarts.delete(key)
    }
    for (const [key, call] of modelCalls) {
      if (!key.startsWith(`${node.rawRunId}\u0000`)) continue
      if (call.requestOrdinal === pendingContextOrdinal) pendingContextOrdinal = undefined
      modelCalls.delete(key)
    }
  }

  return {
    attemptStarts,
    settledAttemptKeys,
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
    recordAttempt,
    settleOpenAttempts,
    persist: () => {
      const persisted: PersistedUsage = {
        usageState: structuredClone(usageState),
        requestOrdinal,
        attemptStarts: [...attemptStarts],
        settledAttemptKeys: [...settledAttemptKeys],
        modelCalls: [...modelCalls],
        activeAvailable,
        activeDepth,
        activeAccumulatedMillis,
      }
      if (pendingContextOrdinal !== undefined) Object.assign(persisted, { pendingContextOrdinal })
      if (activeSince !== undefined) Object.assign(persisted, { activeSince })
      if (lastLifecycleAt !== undefined) Object.assign(persisted, { lastLifecycleAt })
      return persisted
    },
    restore: (persisted) => {
      usageState = structuredClone(persisted.usageState)
      requestOrdinal = persisted.requestOrdinal
      pendingContextOrdinal = persisted.pendingContextOrdinal
      attemptStarts.clear()
      for (const [key, value] of persisted.attemptStarts) attemptStarts.set(key, value)
      settledAttemptKeys.clear()
      for (const key of persisted.settledAttemptKeys) settledAttemptKeys.add(key)
      modelCalls.clear()
      for (const [key, value] of persisted.modelCalls) modelCalls.set(key, value)
      activeAvailable = persisted.activeAvailable
      activeDepth = persisted.activeDepth
      activeAccumulatedMillis = persisted.activeAccumulatedMillis
      activeSince = persisted.activeSince
      lastLifecycleAt = persisted.lastLifecycleAt
      if (
        attemptStarts.size > Projection.limits.inFlightAttempts ||
        settledAttemptKeys.size > Projection.limits.settledAttemptKeys ||
        modelCalls.size > Projection.limits.modelCalls ||
        activeDepth < 0 ||
        activeAccumulatedMillis < 0 ||
        (activeDepth === 0) !== (activeSince === undefined)
      )
        throw new TypeError("Invalid bounded Generalist usage checkpoint")
    },
  }
}
