import type { RunEvent } from "tenetkit/runtime"
import * as Projection from "@rika/product/execution-projection"
import { type Node } from "./model"
import { type AttemptStart, type ModelCallState } from "./persistence"
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
      throw new TypeError(`TenetKit lifecycle timestamp regressed: ${event.eventId}`)
    lastLifecycleAt = at
    return at
  }

  const activate = (node: Node, event: RunEvent.RunEvent) => {
    const at = observeLifecycleAt(event)
    if (node.lifecycle === "active") throw new TypeError(`TenetKit Run ${node.rawRunId} activated twice`)
    if (node.lifecycle === "terminal") throw new TypeError(`TenetKit Run ${node.rawRunId} activated after terminal`)
    if (activeDepth === 0) activeSince = at
    activeDepth += 1
    activeAvailable = true
    node.lifecycle = "active"
  }

  const deactivate = (node: Node, event: RunEvent.RunEvent, next: "waiting" | "terminal") => {
    const at = observeLifecycleAt(event)
    if (node.lifecycle === "active") {
      if (activeDepth <= 0 || activeSince === undefined) throw new TypeError("Invalid TenetKit active-time depth")
      activeDepth -= 1
      if (activeDepth === 0) {
        activeAccumulatedMillis += at - activeSince
        activeSince = undefined
      }
    } else if (next === "waiting" && node.lifecycle !== "unknown" && node.lifecycle !== "accepted")
      throw new TypeError(`TenetKit Run ${node.rawRunId} waited while ${node.lifecycle}`)
    else if (next === "terminal" && node.lifecycle === "terminal")
      throw new TypeError(`TenetKit Run ${node.rawRunId} settled twice`)
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
    const next: Projection.TokenTotals = {
      ...(add(current?.total, value.attemptTotal) === undefined
        ? {}
        : { total: add(current?.total, value.attemptTotal)! }),
      input: {
        ...(add(current?.input.total, value.inputTotal) === undefined
          ? {}
          : { total: add(current?.input.total, value.inputTotal)! }),
        ...(add(current?.input.uncached, value.inputUncached) === undefined
          ? {}
          : { uncached: add(current?.input.uncached, value.inputUncached)! }),
        ...(add(current?.input.cacheRead, value.inputCacheRead) === undefined
          ? {}
          : { cacheRead: add(current?.input.cacheRead, value.inputCacheRead)! }),
        ...(add(current?.input.cacheWrite, value.inputCacheWrite) === undefined
          ? {}
          : { cacheWrite: add(current?.input.cacheWrite, value.inputCacheWrite)! }),
      },
      output: {
        ...(add(current?.output.total, value.outputTotal) === undefined
          ? {}
          : { total: add(current?.output.total, value.outputTotal)! }),
        ...(add(current?.output.text, value.outputText) === undefined
          ? {}
          : { text: add(current?.output.text, value.outputText)! }),
        ...(add(current?.output.reasoning, value.outputReasoning) === undefined
          ? {}
          : { reasoning: add(current?.output.reasoning, value.outputReasoning)! }),
      },
      ...(add(current?.failedProviderTotal, value.failedProviderTotal) === undefined
        ? {}
        : { failedProviderTotal: add(current?.failedProviderTotal, value.failedProviderTotal)! }),
    }
    if (JSON.stringify(next) !== JSON.stringify({ input: {}, output: {} })) usageState = { ...usageState, tokens: next }
  }

  const rememberSettled = (key: string): boolean => {
    if (settledAttemptKeys.has(key)) return false
    settledAttemptKeys.add(key)
    while (settledAttemptKeys.size > Projection.limits.settledAttemptKeys)
      settledAttemptKeys.delete(settledAttemptKeys.values().next().value!)
    return true
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
    let pricingPatch: Record<string, number>
    if (pricing === "included") pricingPatch = { includedAttempts: (usageState.includedAttempts ?? 0) + 1 }
    else if (input.costNanoUsd === undefined) pricingPatch = { unpricedAttempts: usageState.unpricedAttempts + 1 }
    else
      pricingPatch = {
        costNanoUsd: add(usageState.costNanoUsd, input.costNanoUsd)!,
        pricedAttempts: usageState.pricedAttempts + 1,
      }
    usageState = {
      ...usageState,
      ...pricingPatch,
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
    activeTime: () =>
      activeAvailable
        ? {
            _tag: "Available",
            accumulatedMillis: activeAccumulatedMillis,
            ...(activeSince === undefined ? {} : { activeSince }),
          }
        : { _tag: "Unavailable" },
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
    persist: () => ({
      usageState: structuredClone(usageState),
      requestOrdinal,
      ...(pendingContextOrdinal === undefined ? {} : { pendingContextOrdinal }),
      attemptStarts: [...attemptStarts],
      settledAttemptKeys: [...settledAttemptKeys],
      modelCalls: [...modelCalls],
      activeAvailable,
      activeDepth,
      activeAccumulatedMillis,
      ...(activeSince === undefined ? {} : { activeSince }),
      ...(lastLifecycleAt === undefined ? {} : { lastLifecycleAt }),
    }),
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
        throw new TypeError("Invalid bounded TenetKit usage checkpoint")
    },
  }
}
