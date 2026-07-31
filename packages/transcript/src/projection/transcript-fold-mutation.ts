import type { Block } from "../schema/transcript-presentation-model"
import { ToolFile as ToolFileSchema } from "../schema/transcript-presentation-model"
type ToolFile = typeof ToolFileSchema.Type
import type { Unit } from "../schema/transcript-unit"
import type { MutableMutation, OwnedFold, FoldMutation } from "./transcript-fold-state"
import { foldState } from "./transcript-fold-state"
import { childScopeAndCallId, executionKey } from "../ordering/child-parent-correlation"
import { identityKey, scopedIdentity } from "../ordering/transcript-unit-identity"

const {
  agentScopeCallKey,
  childBlockFrom,
  enumerateKeys,
  firstIndexedUnit,
  indexUnit,
  recomputeLatestRootTool,
  toolBlockFrom,
  unindexUnit,
} = foldState

interface MutableProjectionState {
  revision: number
  modelPhase: number
  usableCompletionSequence: number | undefined
  oldestCursor: string | undefined
  checkpointCursor: string | undefined
  costUsd: number | undefined
  pricingVersion: string | undefined
}

interface ChildOutcome {
  readonly childId: string
  readonly outcome: NonNullable<Unit["executionOutcome"]>
}

const mutation = (): MutableMutation => ({ stateChanged: false, upsert: new Map(), remove: new Set() })

const result = (change: MutableMutation): FoldMutation => ({
  stateChanged: change.stateChanged,
  units: { upsert: [...change.upsert.values()], remove: [...change.remove] },
})

const setState = <K extends keyof MutableProjectionState>(
  value: OwnedFold,
  change: MutableMutation,
  key: K,
  next: MutableProjectionState[K],
): void => {
  if (value.state[key] === next) return
  value.state[key] = next
  change.stateChanged = true
}

const outcomeStatus = (outcome: NonNullable<Unit["executionOutcome"]>) => outcome.status

const outcomeForUnit = (value: OwnedFold, unit: Unit): ChildOutcome | undefined => {
  const tool = toolBlockFrom(unit)
  if (tool !== undefined) {
    if (tool.childId !== undefined) return value.childOutcomes.get(executionKey(tool.childId))
    if (tool.presentation.family !== "agent") return undefined
    const matches = value.childOutcomesByScopeCall.get(
      agentScopeCallKey({
        id: tool.id,
        scope: unit.turnId,
        childId: undefined,
        family: tool.presentation.family,
      }),
    )
    if (matches?.size !== 1) return undefined
    return value.childOutcomes.get(matches.values().next().value!)
  }
  const child = childBlockFrom(unit)
  return child === undefined ? undefined : value.childOutcomes.get(executionKey(child.id))
}

const withAuthoritativeChildOutcome = (value: OwnedFold, incoming: Unit): Unit => {
  const known = outcomeForUnit(value, incoming)
  if (known === undefined || incoming.content._tag !== "Block") return incoming
  const block = incoming.content.block
  if (block._tag === "ToolCall")
    return {
      ...incoming,
      content: {
        _tag: "Block",
        block: { ...block, childId: known.childId, status: outcomeStatus(known.outcome) },
      },
    }
  if (block._tag === "ChildAgent")
    return {
      ...incoming,
      content: { _tag: "Block", block: { ...block, status: outcomeStatus(known.outcome) } },
    }
  return incoming
}

const upsertUnit = (value: OwnedFold, change: MutableMutation, incoming: Unit): Unit => {
  const previous = value.units.get(incoming.key)
  const authoritative = withAuthoritativeChildOutcome(value, incoming)
  const next = previous === undefined ? authoritative : { ...authoritative, order: previous.order }
  if (previous !== undefined) unindexUnit(value, previous)
  value.units.set(next.key, next)
  indexUnit(value, next)
  change.remove.delete(next.key)
  change.upsert.set(next.key, next)
  return next
}

const removeUnit = (value: OwnedFold, change: MutableMutation, key: string): void => {
  const previous = value.units.get(key)
  if (previous === undefined) return
  unindexUnit(value, previous)
  value.units.delete(key)
  if (value.latestRootToolKey === key) recomputeLatestRootTool(value)
  change.upsert.delete(key)
  change.remove.add(key)
}

const unitByToolId = (value: OwnedFold, id: string): Unit | undefined => {
  const key = value.toolsById.get(id)
  if (key === undefined) return undefined
  value.observer?.unitLookup?.(key)
  return value.units.get(key)
}

const toolAt = (value: OwnedFold, id: string): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const unit = unitByToolId(value, id)
  return unit === undefined ? undefined : toolBlockFrom(unit)
}

const updateTool = (
  value: OwnedFold,
  change: MutableMutation,
  id: string,
  sequence: number,
  update: (tool: Extract<Block, { _tag: "ToolCall" }>) => Extract<Block, { _tag: "ToolCall" }>,
): Unit | undefined => {
  const current = unitByToolId(value, id)
  const tool = current === undefined ? undefined : toolBlockFrom(current)
  if (current === undefined || tool === undefined) return undefined
  return upsertUnit(value, change, {
    ...current,
    revision: sequence,
    content: { _tag: "Block", block: update(tool) },
  })
}

const linkedToolUnitFor = (
  value: OwnedFold,
  turnId: string,
  childId: string,
  correlatedToolId: string,
): Unit | undefined => {
  if (correlatedToolId.length > 0) {
    const correlated = unitByToolId(value, scopedIdentity(turnId, correlatedToolId))
    if (correlated !== undefined) return correlated
  }
  const childKey = executionKey(childId)
  const linked = value.toolsByChild.get(childKey)
  let linkedFallback: Unit | undefined
  if (linked !== undefined)
    for (const unit of enumerateKeys(value, linked)) {
      const tool = toolBlockFrom(unit)
      if (tool === undefined) continue
      linkedFallback ??= unit
      if (executionKey(tool.id) !== childKey) return unit
    }
  const parsed = childScopeAndCallId(childId)
  if (parsed !== undefined) {
    const matched = firstIndexedUnit(
      value,
      value.agentToolsByScopeCall.get(identityKey("agent-scope-call", parsed.scope, parsed.callId)),
    )
    if (matched !== undefined) return matched
  }
  if (linkedFallback !== undefined) return linkedFallback
  return parsed === undefined ? undefined : unitByToolId(value, scopedIdentity(turnId, parsed.rawCallId))
}

const linkedToolFor = (
  value: OwnedFold,
  turnId: string,
  childId: string,
  correlatedToolId: string,
): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const unit = linkedToolUnitFor(value, turnId, childId, correlatedToolId)
  return unit === undefined ? undefined : toolBlockFrom(unit)
}

const lineCounts = (patch: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

const normalizedDiffPath = (value: string): string => value.replace(/^(?:a|b)\//, "")

const unifiedFiles = (callId: string, diff: string, failed: boolean): ReadonlyArray<ToolFile> => {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0)
  const ranges = starts.length === 0 ? [0] : starts
  return ranges.flatMap((start, ordinal) => {
    const end = ranges[ordinal + 1] ?? diff.length
    const patch = diff.slice(start, end).trimEnd()
    const oldPath = /^--- (.+)$/m.exec(patch)?.[1]
    const newPath = /^\+\+\+ (.+)$/m.exec(patch)?.[1]
    if (oldPath === undefined && newPath === undefined) return []
    const created = oldPath === "/dev/null" || /new file mode/m.test(patch)
    const deleted = newPath === "/dev/null" || /deleted file mode/m.test(patch)
    const path = normalizedDiffPath(deleted ? oldPath! : newPath!)
    const previousPath = oldPath === undefined || oldPath === "/dev/null" ? undefined : normalizedDiffPath(oldPath)
    let kind: ToolFile["kind"] = "update"
    if (created) kind = "add"
    else if (deleted) kind = "delete"
    else if (previousPath !== path) kind = "move"
    return [
      {
        key: `${callId}:${ordinal}`,
        path,
        kind,
        patch,
        ...lineCounts(patch),
        preview: false,
        status: failed ? "failed" : "complete",
        ...(kind === "move" && previousPath !== undefined ? { previousPath } : {}),
      } satisfies ToolFile,
    ]
  })
}

export const mutationOperations = {
  mutation,
  result,
  setState,
  outcomeForUnit,
  upsertUnit,
  removeUnit,
  toolAt,
  updateTool,
  linkedToolUnitFor,
  linkedToolFor,
  unifiedFiles,
}
