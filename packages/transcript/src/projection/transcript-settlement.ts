import { compareUnitOrder } from "../ordering/transcript-unit-order"
import { executionKey } from "../ordering/child-parent-correlation"
import { identityKey } from "../ordering/transcript-unit-identity"
import type { Block } from "../schema/transcript-presentation-model"
import type { Projection } from "../schema/transcript-projection-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { Unit } from "../schema/transcript-unit"
import type { MutableMutation, OwnedFold } from "./transcript-fold-state"
import { assistantKey, reasoningKey } from "./transcript-model-event-fold"
import { foldState } from "./transcript-fold-state"
const {
  childBlockFrom,
  enumerateKeys,
  firstIndexedUnit,
  isRootUnit,
  linkedToolUnitFor,
  makeUnit,
  record,
  setState,
  sourcePayload,
  toolBlockFrom,
  updateTool,
  upsertUnit,
} = foldState

const settledBlock = (block: Block, status: "failed" | "cancelled"): Block | undefined => {
  if (block._tag === "ToolCall" && block.status === "running") return { ...block, status }
  if (block._tag === "ChildAgent" && block.status === "running") return { ...block, status }
  if (block._tag === "Compaction" && block.status === "running") return { ...block, status }
  return undefined
}

const settleRunningInto = (
  value: OwnedFold,
  change: MutableMutation,
  status: "failed" | "cancelled",
  sequence: number,
): void => {
  for (const unit of enumerateKeys(value, value.runningUnits)) {
    value.observer?.runningUnitVisited?.(unit)
    if (unit.content._tag !== "Block") continue
    const settled = settledBlock(unit.content.block, status)
    if (settled === undefined) continue
    upsertUnit(value, change, {
      ...unit,
      revision: Math.max(unit.revision, sequence),
      content: { _tag: "Block", block: settled },
    })
  }
}

const settleChildInto = (
  value: OwnedFold,
  change: MutableMutation,
  childId: string,
  status: "complete" | "failed" | "cancelled",
  sequence: number,
  authoritative: boolean,
): void => {
  const linkedUnit = linkedToolUnitFor(value, value.turnId, childId, "")
  const linkedTool = linkedUnit === undefined ? undefined : toolBlockFrom(linkedUnit)
  if (
    linkedTool !== undefined &&
    (authoritative || linkedTool.status === "running") &&
    (linkedTool.status !== status || executionKey(linkedTool.childId ?? "") !== executionKey(childId))
  )
    updateTool(value, change, linkedTool.id, Math.max(sequence, linkedUnit!.revision), (tool) => ({
      ...tool,
      childId,
      status,
    }))
  const childKeys = value.childUnitsById.get(executionKey(childId))
  if (childKeys === undefined) return
  const childUnits = Array.from(enumerateKeys(value, childKeys))
  for (const unit of childUnits) {
    const block = childBlockFrom(unit)
    if (block === undefined || (!authoritative && block.status !== "running") || block.status === status) continue
    upsertUnit(value, change, {
      ...unit,
      revision: Math.max(unit.revision, sequence),
      content: { _tag: "Block", block: { ...block, status } },
    })
  }
}

const advanceModelPhase = (value: OwnedFold, change: MutableMutation, turnId: string): void => {
  const phase = Math.max(0, value.state.modelPhase)
  if (value.units.has(assistantKey({ turnId, phase })) || value.units.has(reasoningKey({ turnId, phase })))
    setState(value, change, "modelPhase", phase + 1)
}

const isTruncatedStream = (event: SourceEvent): boolean => {
  const payload = sourcePayload(event)
  if (payload.category === "truncated-stream") return true
  return record(payload.details).failure_classification === "truncated-stream"
}

const hasUsableFinalResponse = (value: OwnedFold): boolean => {
  const completionSequence = value.state.usableCompletionSequence
  if (completionSequence === undefined) return false
  const candidates = value.assistantUnitsByRevision.get(completionSequence)
  if (candidates === undefined) return false
  const latestTool = value.latestRootToolKey === undefined ? undefined : value.units.get(value.latestRootToolKey)
  for (const unit of enumerateKeys(value, candidates))
    if (
      unit.turnId === value.turnId &&
      isRootUnit(unit) &&
      unit.content._tag === "Entry" &&
      unit.content.role === "assistant" &&
      unit.content.text.trim().length > 0 &&
      (latestTool === undefined || compareUnitOrder(unit.order, latestTool.order) > 0)
    )
      return true
  return false
}

const clearExecutionOutcomes = (value: OwnedFold, change: MutableMutation): void => {
  for (const unit of Array.from(enumerateKeys(value, value.outcomeUnits))) {
    const { executionOutcome: _executionOutcome, ...withoutOutcome } = unit
    upsertUnit(value, change, withoutOutcome)
  }
}

const applyExecutionOutcome = (
  value: OwnedFold,
  change: MutableMutation,
  turnId: string,
  revision: number,
  outcome: NonNullable<Unit["executionOutcome"]>,
): void => {
  clearExecutionOutcomes(value, change)
  const current = firstIndexedUnit(value, value.rootUserUnits)
  if (current !== undefined) {
    upsertUnit(value, change, { ...current, revision, executionOutcome: outcome })
    return
  }
  upsertUnit(value, change, {
    ...makeUnit(identityKey("execution", turnId, "outcome"), turnId, Number.MAX_SAFE_INTEGER, 0, revision, {
      _tag: "Entry",
      role: "notice",
      text: "",
    }),
    executionOutcome: outcome,
  })
}

const steeringMessageTexts = (event: SourceEvent, count: number): ReadonlyArray<string> => {
  const parts = (event.content ?? []).flatMap((part) => {
    const value = record(part)
    return value.type === "text" && typeof value.text === "string" ? [value.text] : []
  })
  if (parts.length === count) return parts.filter((text) => text.length > 0)
  const joined = event.text ?? parts.join("\n")
  return joined.length === 0 ? [] : [joined]
}

const applySteeringDelivered = (
  value: OwnedFold,
  change: MutableMutation,
  turnId: string,
  event: SourceEvent,
): void => {
  const payload = sourcePayload(event)
  const count = typeof payload.message_count === "number" ? payload.message_count : 0
  if (count === 0) return
  for (const [index, text] of steeringMessageTexts(event, count).entries())
    upsertUnit(
      value,
      change,
      makeUnit(identityKey("steering", turnId, event.sequence, index), turnId, event.sequence, index, event.sequence, {
        _tag: "Entry",
        role: "user",
        text,
      }),
    )
}

export const settlementOperations = {
  settleRunningInto,
  settleChildInto,
  advanceModelPhase,
  isTruncatedStream,
  hasUsableFinalResponse,
  clearExecutionOutcomes,
  applyExecutionOutcome,
  applySteeringDelivered,
}

import { Function } from "effect"
const { mutation: makeMutation, owner, restoreProjectionFold, result } = foldState
const { snapshotFoldProjection } = foldState
import type { FoldMutation } from "./transcript-fold-state"

const projectionChanged = (mutation: FoldMutation): boolean =>
  mutation.stateChanged || mutation.units.upsert.length > 0 || mutation.units.remove.length > 0

export const settleRunning: {
  (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection
  (status: "failed" | "cancelled", sequence: number): (projection: Projection) => Projection
} = Function.dual(3, (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection => {
  const fold = restoreProjectionFold(projection)
  const change = makeMutation()
  settleRunningInto(owner(fold), change, status, sequence)
  return projectionChanged(result(change)) ? snapshotFoldProjection(fold) : projection
})

export const settleChild: {
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): Projection
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (projection: Projection) => Projection
} = Function.dual(
  4,
  (
    projection: Projection,
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): Projection => {
    const fold = restoreProjectionFold(projection)
    const change = makeMutation()
    settleChildInto(owner(fold), change, childId, status, sequence, false)
    return projectionChanged(result(change)) ? snapshotFoldProjection(fold) : projection
  },
)
