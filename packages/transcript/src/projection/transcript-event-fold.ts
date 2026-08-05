import { Function } from "effect"
import { executionKey } from "../ordering/child-parent-correlation"
import { identityKey } from "../ordering/transcript-unit-identity"
import type { Block } from "../schema/transcript-presentation-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { Unit } from "../schema/transcript-unit"
import type { ModelFailure } from "../schema/transcript-projection-model"
import { applyAssistant, applyReasoning, applyUsage, assistantKey, reasoningKey } from "./transcript-model-event-fold"
import { applyChild } from "./transcript-child-event-fold"
import { genericBlock, genericKey } from "./transcript-generic-event-fold"
import { applyToolDelta, applyToolProgress, applyToolRequested, applyToolResult } from "./transcript-tool-event-fold"
import { settlementOperations } from "./transcript-settlement"
const {
  advanceModelPhase,
  applyExecutionOutcome,
  applySteeringDelivered,
  clearExecutionOutcomes,
  hasUsableFinalResponse,
  isTruncatedStream,
  settleChildInto,
  settleRunningInto,
} = settlementOperations
import { foldState } from "./transcript-fold-state"
import { mutationOperations } from "./transcript-fold-mutation"
const { mutation, removeUnit, result, setState, upsertUnit, linkedToolUnitFor } = mutationOperations
const {
  firstIndexedUnit,
  isTransientEvent,
  makeProjectionFold,
  restoreProjectionFold,
  makeUnit,
  owner,
  rawToolId,
  record,
  snapshotFoldState,
  snapshotFoldProjection,
  foldUnit,
  foldUnits,
  sourcePayload,
  string,
  toolKey,
} = foldState
import type { FoldMutation, MutableMutation, OwnedFold, ProjectionFold } from "./transcript-fold-state"

const modelFailure = (event: SourceEvent, previous?: ModelFailure): ModelFailure | undefined => {
  const payload = sourcePayload(event)
  const modelCallId = string(payload.model_call_id)
  const category = string(payload.category)
  const classification = string(payload.classification)
  if (modelCallId.length === 0 || category.length === 0 || classification.length === 0) return undefined
  const matchesPrevious = previous?.modelCallId === modelCallId
  const purpose = string(payload.purpose)
  const provider = string(payload.provider)
  const model = string(payload.model)
  let resolvedProvider = provider.length > 0 ? provider : undefined
  let resolvedModel = model.length > 0 ? model : undefined
  if (resolvedProvider === undefined && matchesPrevious) resolvedProvider = previous?.provider
  if (resolvedModel === undefined && matchesPrevious) resolvedModel = previous?.model
  return {
    modelCallId,
    category,
    classification,
    ...(purpose.length === 0 ? {} : { purpose }),
    ...(typeof payload.attempts === "number" ? { attempts: payload.attempts } : {}),
    ...(resolvedProvider === undefined ? {} : { provider: resolvedProvider }),
    ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
  }
}

const failurePresentation = (failure: ModelFailure | undefined, reason: string) => {
  const category = failure?.category
  let title = "Execution failed"
  let recovery = "Edit your prompt and press Enter to try again."
  if (category === "authentication") {
    title = "Model authentication failed"
    recovery = "Check the provider credential, restart Rika, then press Enter to retry."
  } else if (category === "rate-limit") {
    title = "Model rate limit reached"
    recovery = "Wait for the provider limit to reset, then press Enter to retry."
  } else if (category === "transport" || category === "timeout") {
    title = "Model provider unavailable"
    recovery = "Check your network and provider status, then press Enter to retry."
  } else if (category === "context-overflow" || category === "token-budget") {
    title = "Thread context is too large"
    recovery = "Try again. If the thread is still too large, start a new thread."
  } else if (category === "invalid-tool-call" || category === "stream-decode" || category === "truncated-stream") {
    title = "Model response was invalid"
    recovery = "Press Enter to retry. If it happens again, choose another model."
  } else if (category === "provider-response") {
    title = "Model request failed"
    recovery = "Press Enter to retry. If it happens again, check the provider status."
  }
  const attribution = [
    failure?.provider === undefined ? undefined : `Provider: ${failure.provider}`,
    failure?.model === undefined ? undefined : `Model: ${failure.model}`,
    failure?.attempts === undefined ? undefined : `Attempts: ${failure.attempts}`,
  ].filter((line): line is string => line !== undefined)
  return { title, detail: [reason, ...attribution].join("\n"), recovery }
}

const applyKnownEvent = (value: OwnedFold, change: MutableMutation, event: SourceEvent): void => {
  const turnId = value.turnId
  if (event.type === "model.input.prepared") {
    if (value.state.modelPhase < 0) setState(value, change, "modelPhase", 0)
    advanceModelPhase(value, change, turnId)
    return
  }
  if (event.type === "model.output.delta") return applyAssistant({ value, change, turnId, event, complete: false })
  if (event.type === "model.output.completed" || event.type === "model.cycle.completed")
    return applyAssistant({ value, change, turnId, event, complete: true })
  if (event.type === "model.reasoning.completed")
    return applyReasoning({ value, change, turnId, event, complete: true })
  if (event.type === "model.reasoning.delta") return applyReasoning({ value, change, turnId, event, complete: false })
  if (event.type === "model.toolcall.delta") return applyToolDelta({ value, change, turnId, event })
  if (event.type === "tool.call.requested" || event.type === "tool.started") {
    applyToolRequested({ value, change, turnId, event })
    advanceModelPhase(value, change, turnId)
    return
  }
  if (event.type === "tool.progress") return applyToolProgress({ value, change, turnId, event })
  if (event.type === "tool.result.received") return applyToolResult({ value, change, turnId, event })
  if (event.type === "steering.delivered") return applySteeringDelivered(value, change, turnId, event)
  if (event.type === "model.attempt.completed") return applyUsage({ value, change, event })
  if (event.type === "model.attempt.failed" || event.type === "model.call.failed") {
    const failure = modelFailure(event, value.state.modelFailure)
    if (failure !== undefined) setState(value, change, "modelFailure", failure)
    if (!isTruncatedStream(event)) return
    const block: Block = {
      _tag: "Notification",
      title: "Model response was cut off",
      detail: "The provider ended the response before it finished. Rika is retrying that step.",
    }
    upsertUnit(
      value,
      change,
      makeUnit(identityKey("truncated", turnId, event.sequence), turnId, event.sequence, 0, event.sequence, {
        _tag: "Block",
        block,
      }),
    )
    return
  }
  if (event.type === "model.call.completed") {
    setState(value, change, "modelFailure", undefined)
    return
  }
  if (event.type === "execution.completed") {
    setState(value, change, "modelFailure", undefined)
    settleRunningInto(value, change, "cancelled", event.sequence)
    applyExecutionOutcome(value, change, turnId, event.sequence, { status: "complete" })
    return
  }
  if (event.type === "execution.failed") {
    if (!isTruncatedStream(event) && hasUsableFinalResponse(value)) {
      settleRunningInto(value, change, "cancelled", event.sequence)
      applyExecutionOutcome(value, change, turnId, event.sequence, { status: "complete" })
      return
    }
    const payload = sourcePayload(event)
    const details = record(payload.details)
    const legacyCategory = string(details.failure_classification)
    const legacyCompactionFailed = value.state.modelFailure === undefined && legacyCategory === "context-overflow"
    const failure =
      value.state.modelFailure ??
      (legacyCategory.length === 0
        ? undefined
        : { modelCallId: event.cursor, category: legacyCategory, classification: "terminal" })
    const reason = event.text ?? string(payload.message, "The execution failed unexpectedly.")
    const presentation = failurePresentation(failure, reason)
    const block: Block = {
      _tag: "Error",
      title:
        failure?.purpose === "compaction-summary" || legacyCompactionFailed
          ? "Auto-compaction failed"
          : presentation.title,
      detail: presentation.detail,
      turnId,
      recovery: presentation.recovery,
    }
    setState(value, change, "modelFailure", undefined)
    settleRunningInto(value, change, "failed", event.sequence)
    clearExecutionOutcomes(value, change)
    upsertUnit(value, change, {
      ...makeUnit(identityKey("execution", turnId, "failed"), turnId, event.sequence, 0, event.sequence, {
        _tag: "Block",
        block,
      }),
      executionOutcome: { status: "failed", reason },
    })
    return
  }
  if (event.type === "execution.cancelled") {
    const payload = sourcePayload(event)
    const reason = event.text ?? string(payload.reason, string(payload.message))
    settleRunningInto(value, change, "cancelled", event.sequence)
    applyExecutionOutcome(value, change, turnId, event.sequence, {
      status: "cancelled",
      ...(reason.length > 0 ? { reason } : {}),
    })
    return
  }
  if (
    event.type === "child_run.spawned" ||
    event.type === "child_run.started" ||
    event.type === "child_run.completed" ||
    event.type === "child_run.failed" ||
    event.type === "child_run.cancelled"
  )
    return applyChild({ value, change, turnId, event })
  const block = genericBlock({ turnId, event })
  if (block === undefined) return
  const key = genericKey({ turnId, event, block })
  const previous = value.units.get(key)
  const previousCompaction =
    previous !== undefined && previous.content._tag === "Block" && previous.content.block._tag === "Compaction"
      ? previous.content.block
      : undefined
  const compactionCheckpoint =
    block._tag === "Compaction" && previousCompaction !== undefined
      ? (block.checkpoint ?? previousCompaction.checkpoint)
      : undefined
  const nextBlock =
    block._tag === "Compaction" && previousCompaction !== undefined
      ? {
          ...block,
          summary: block.summary.length > 0 ? block.summary : previousCompaction.summary,
          ...(compactionCheckpoint === undefined ? {} : { checkpoint: compactionCheckpoint }),
        }
      : block
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block: nextBlock,
    }),
  )
}

const transientAttempt = (event: SourceEvent): string => {
  const payload = sourcePayload(event)
  return identityKey("transient-attempt", string(payload.model_call_id), string(payload.model_attempt_id))
}

const transientIndex = (event: SourceEvent): number =>
  typeof event.data?.transient_index === "number" ? event.data.transient_index : -1

const transientUnitKey = (value: OwnedFold, event: SourceEvent): string | undefined => {
  if (event.type === "model.output.delta") return assistantKey({ turnId: value.turnId, phase: value.state.modelPhase })
  if (event.type === "model.reasoning.delta")
    return reasoningKey({ turnId: value.turnId, phase: value.state.modelPhase })
  if (event.type === "model.toolcall.delta") return toolKey(value.turnId, rawToolId(event))
  return undefined
}

const durableResolutionKey = (value: OwnedFold, event: SourceEvent): string | undefined => {
  if (event.type === "model.output.completed" || event.type === "model.cycle.completed")
    return assistantKey({ turnId: value.turnId, phase: value.state.modelPhase })
  if (event.type === "model.reasoning.completed")
    return reasoningKey({ turnId: value.turnId, phase: value.state.modelPhase })
  if (event.type === "tool.call.requested" || event.type === "tool.started")
    return toolKey(value.turnId, rawToolId(event))
  return undefined
}

const restoreTransientBase = (value: OwnedFold, change: MutableMutation, key: string): void => {
  if (!value.transientBases.has(key)) return
  const base = value.transientBases.get(key)
  if (base === undefined) removeUnit(value, change, key)
  else upsertUnit(value, change, base)
  value.transientBases.delete(key)
  for (const attempt of value.transientAttemptsByUnit.get(key) ?? []) {
    const units = value.transientUnitsByAttempt.get(attempt)
    units?.delete(key)
    if (units?.size === 0) {
      value.transientUnitsByAttempt.delete(attempt)
      value.transientIndexes.delete(attempt)
    }
  }
  value.transientAttemptsByUnit.delete(key)
}

const requiresResolvedTransients = (event: SourceEvent): boolean =>
  event.type === "model.input.prepared" ||
  event.type === "tool.call.requested" ||
  event.type === "tool.started" ||
  event.type === "tool.result.received" ||
  event.type === "steering.delivered" ||
  event.type === "execution.completed" ||
  event.type === "execution.failed" ||
  event.type === "execution.cancelled"

const blockingTransientKeys = (value: OwnedFold, event: SourceEvent): ReadonlyArray<string> => {
  const toolBatchBoundary =
    event.type === "tool.call.requested" || event.type === "tool.started" || event.type === "tool.result.received"
  const unresolvedResultKey =
    event.type === "tool.result.received" ? toolKey(value.turnId, rawToolId(event)) : undefined
  return [...value.transientBases.keys()].filter((key) => {
    if (!toolBatchBoundary || key === unresolvedResultKey) return true
    const unit = value.units.get(key)
    return unit?.content._tag !== "Block" || unit.content.block._tag !== "ToolCall"
  })
}

const applyFoldEvent: {
  (fold: ProjectionFold, event: SourceEvent): FoldMutation
  (event: SourceEvent): (fold: ProjectionFold) => FoldMutation
} = Function.dual(2, (fold: ProjectionFold, event: SourceEvent): FoldMutation => {
  const value = owner(fold)
  const change = mutation()
  if (isTransientEvent(event)) {
    if (event.sequence < value.state.revision) return result(change)
    const attempt = transientAttempt(event)
    const index = transientIndex(event)
    if (index <= (value.transientIndexes.get(attempt) ?? -1)) return result(change)
    const key = transientUnitKey(value, event)
    if (key !== undefined) {
      if (!value.transientBases.has(key)) value.transientBases.set(key, value.units.get(key))
      const attempts = value.transientAttemptsByUnit.get(key) ?? new Set<string>()
      attempts.add(attempt)
      value.transientAttemptsByUnit.set(key, attempts)
      const units = value.transientUnitsByAttempt.get(attempt) ?? new Set<string>()
      units.add(key)
      value.transientUnitsByAttempt.set(attempt, units)
    }
    applyKnownEvent(value, change, event)
    value.transientIndexes.set(attempt, index)
    return result(change)
  }
  if (event.sequence <= value.state.revision) {
    if (event.type === "model.attempt.completed") applyUsage({ value, change, event })
    return result(change)
  }
  const unresolved = requiresResolvedTransients(event) ? blockingTransientKeys(value, event) : []
  if (unresolved.length > 0)
    throw new TypeError(
      `Transcript ${value.turnId} reached ${event.type} with unresolved transient units ${unresolved.join(", ")}`,
    )
  const resolvedKey = durableResolutionKey(value, event)
  if (resolvedKey !== undefined) restoreTransientBase(value, change, resolvedKey)
  applyKnownEvent(value, change, event)
  setState(value, change, "revision", event.sequence)
  if (value.state.oldestCursor === undefined) setState(value, change, "oldestCursor", event.cursor)
  setState(value, change, "checkpointCursor", event.cursor)
  return result(change)
})

const settleFoldRunning: {
  (fold: ProjectionFold, status: "failed" | "cancelled", sequence: number): FoldMutation
  (status: "failed" | "cancelled", sequence: number): (fold: ProjectionFold) => FoldMutation
} = Function.dual(3, (fold: ProjectionFold, status: "failed" | "cancelled", sequence: number): FoldMutation => {
  const value = owner(fold)
  const change = mutation()
  settleRunningInto(value, change, status, sequence)
  return result(change)
})

const settleFoldChild: {
  (fold: ProjectionFold, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): FoldMutation
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (fold: ProjectionFold) => FoldMutation
} = Function.dual(
  4,
  (
    fold: ProjectionFold,
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): FoldMutation => {
    const value = owner(fold)
    const change = mutation()
    settleChildInto(value, change, childId, status, sequence, false)
    return result(change)
  },
)

const applyChildOutcome: {
  (fold: ProjectionFold, childId: string, outcome: NonNullable<Unit["executionOutcome"]>): FoldMutation
  (childId: string, outcome: NonNullable<Unit["executionOutcome"]>): (fold: ProjectionFold) => FoldMutation
} = Function.dual(
  3,
  (fold: ProjectionFold, childId: string, outcome: NonNullable<Unit["executionOutcome"]>): FoldMutation => {
    const value = owner(fold)
    const change = mutation()
    const childKey = executionKey(childId)
    value.childOutcomes.set(childKey, { childId, outcome })
    settleChildInto(value, change, childId, outcome.status, value.state.revision, true)
    return result(change)
  },
)

const applyAncestorOutcome: {
  (
    fold: ProjectionFold,
    outcome: NonNullable<Unit["executionOutcome"]> & { readonly status: "failed" | "cancelled" },
  ): FoldMutation
  (
    outcome: NonNullable<Unit["executionOutcome"]> & { readonly status: "failed" | "cancelled" },
  ): (fold: ProjectionFold) => FoldMutation
} = Function.dual(
  2,
  (
    fold: ProjectionFold,
    outcome: NonNullable<Unit["executionOutcome"]> & { readonly status: "failed" | "cancelled" },
  ): FoldMutation => {
    const value = owner(fold)
    const change = mutation()
    settleRunningInto(value, change, outcome.status, value.state.revision)
    return result(change)
  },
)

const foldExecutionOutcome = (fold: ProjectionFold): NonNullable<Unit["executionOutcome"]> | undefined => {
  const value = owner(fold)
  const unit = firstIndexedUnit(value, value.outcomeUnits)
  return unit?.executionOutcome
}

const foldHasRunningUnits = (fold: ProjectionFold): boolean => owner(fold).runningUnits.size > 0

const parentToolForChild: {
  (fold: ProjectionFold, turnId: string, childId: string): Unit | undefined
  (turnId: string, childId: string): (fold: ProjectionFold) => Unit | undefined
} = Function.dual(3, (fold: ProjectionFold, turnId: string, childId: string): Unit | undefined =>
  linkedToolUnitFor(owner(fold), turnId, childId, ""),
)

export const foldOperations = {
  applyFoldEvent,
  settleFoldRunning,
  settleFoldChild,
  applyChildOutcome,
  applyAncestorOutcome,
  foldExecutionOutcome,
  foldHasRunningUnits,
  parentToolForChild,
  snapshotFoldState,
  snapshotFoldProjection,
  foldUnit,
  foldUnits,
  makeProjectionFold,
  restoreProjectionFold,
  isTransientEvent,
}
export type { FoldMutation, ProjectionFold }
