import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as ThreadView from "@rika/product/thread-view"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Function } from "effect"

const maximumCharacters = ExecutionGateway.ModelPreviewMaxCharacters

export interface Overlay {
  readonly turnId: string
  readonly preview: ExecutionGateway.ModelPreviewed
  readonly identity: string
  readonly baselineAuthoritativeUnitKeys: ReadonlySet<string>
  readonly retiredIdentities: ReadonlyArray<string>
}

const previewIdentity = (preview: ExecutionGateway.ModelPreviewed): string =>
  JSON.stringify([
    preview.key.runId,
    preview.key.attemptFence,
    preview.key.turn,
    preview.key.modelCallId,
    preview.key.modelAttemptId,
    preview.key.attempt,
  ])

const compareAttempt = (left: ExecutionGateway.ModelPreviewed, right: ExecutionGateway.ModelPreviewed): number => {
  if (left.key.attemptFence !== right.key.attemptFence) return left.key.attemptFence - right.key.attemptFence
  if (left.key.turn !== right.key.turn) return left.key.turn - right.key.turn
  return left.key.attempt - right.key.attempt
}

const retiredIdentityCapacity = 64

export const retireIdentity: {
  (value: string): (retired: ReadonlyArray<string>) => ReadonlyArray<string>
  (retired: ReadonlyArray<string>, value: string): ReadonlyArray<string>
} = Function.dual(2, (retired: ReadonlyArray<string>, value: string): ReadonlyArray<string> => {
  if (retired.includes(value)) return retired
  return [value, ...retired].slice(0, retiredIdentityCapacity)
})

export const isRetired: {
  (value: string): (retired: ReadonlyArray<string>) => boolean
  (retired: ReadonlyArray<string>, value: string): boolean
} = Function.dual(2, (retired: ReadonlyArray<string>, value: string): boolean => retired.includes(value))

const bounded = (preview: ExecutionGateway.ModelPreviewed): ExecutionGateway.ModelPreviewed => {
  const text = preview.text.slice(0, maximumCharacters)
  const reasoning = preview.reasoning.slice(0, maximumCharacters - text.length)
  if (text === preview.text && reasoning === preview.reasoning) return preview
  return { ...preview, text, reasoning, truncated: true }
}

const authoritative = (unit: TranscriptUnit.Unit): boolean => {
  if (unit.content._tag === "Entry") return unit.content.role === "assistant"
  const tag = unit.content.block._tag
  return (
    tag === "Reasoning" ||
    tag === "ToolCall" ||
    tag === "Cell" ||
    tag === "SubagentCard" ||
    tag === "Notification" ||
    tag === "Error"
  )
}

const authoritativeUnitKeys = (view: ThreadView.ThreadViewSnapshot, turnId: string): ReadonlySet<string> =>
  new Set(
    view.turns
      .find((candidate) => String(candidate.turn.id) === turnId)
      ?.units.filter(authoritative)
      .map((unit) => unit.key) ?? [],
  )

const replaceImpl = (
  current: Overlay | undefined,
  view: ThreadView.ThreadViewSnapshot,
  turnId: string,
  incoming: ExecutionGateway.ModelPreviewed,
  retired: ReadonlyArray<string> = [],
): Overlay | undefined => {
  const preview = bounded(incoming)
  const nextIdentity = previewIdentity(preview)
  if (current === undefined || current.turnId !== turnId) {
    if (isRetired(retired, nextIdentity)) return current
    return {
      turnId,
      preview,
      identity: nextIdentity,
      baselineAuthoritativeUnitKeys: authoritativeUnitKeys(view, turnId),
      retiredIdentities: [],
    }
  }
  if (current.retiredIdentities.includes(nextIdentity)) return current
  if (current.identity === nextIdentity)
    return preview.revision <= current.preview.revision ? current : { ...current, preview }
  if (compareAttempt(preview, current.preview) <= 0) return current
  return {
    turnId,
    preview,
    identity: nextIdentity,
    baselineAuthoritativeUnitKeys: authoritativeUnitKeys(view, turnId),
    retiredIdentities: [current.identity, ...current.retiredIdentities].slice(0, retiredIdentityCapacity),
  }
}

export const replace: {
  (
    view: ThreadView.ThreadViewSnapshot,
    turnId: string,
    incoming: ExecutionGateway.ModelPreviewed,
    retired: ReadonlyArray<string>,
  ): (current: Overlay | undefined) => Overlay | undefined
  (
    current: Overlay | undefined,
    view: ThreadView.ThreadViewSnapshot,
    turnId: string,
    incoming: ExecutionGateway.ModelPreviewed,
    retired: ReadonlyArray<string>,
  ): Overlay | undefined
} = Function.dual(5, replaceImpl)

const terminal = (status: ThreadView.ThreadViewTurnRecord["status"]): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

const reconcileImpl = (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): Overlay | undefined => {
  if (overlay === undefined) return undefined
  const turn = view.turns.find((candidate) => String(candidate.turn.id) === overlay.turnId)
  if (turn === undefined || terminal(turn.turn.status)) return undefined
  for (const unit of turn.units)
    if (authoritative(unit) && !overlay.baselineAuthoritativeUnitKeys.has(unit.key)) return undefined
  return overlay
}

export const reconcile: {
  (view: ThreadView.ThreadViewSnapshot): (overlay: Overlay | undefined) => Overlay | undefined
  (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): Overlay | undefined
} = Function.dual(2, reconcileImpl)

const unitsImpl = (
  overlay: Overlay | undefined,
  view: ThreadView.ThreadViewSnapshot,
): ReadonlyArray<TranscriptUnit.Unit> => {
  const current = reconcile(overlay, view)
  if (current === undefined) return []
  const turn = view.turns.find((candidate) => String(candidate.turn.id) === current.turnId)
  if (turn === undefined) return []
  const result: Array<TranscriptUnit.Unit> = []
  const prefix = `tentative:${current.turnId}:${current.identity}`
  if (current.preview.reasoning.length > 0) {
    const key = `${prefix}:reasoning`
    result.push({
      key,
      turnId: current.turnId,
      order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 0),
      revision: current.preview.revision,
      content: { _tag: "Block", block: { _tag: "Reasoning", text: current.preview.reasoning } },
    })
  }
  if (current.preview.text.length > 0) {
    const key = `${prefix}:assistant`
    result.push({
      key,
      turnId: current.turnId,
      order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 1),
      revision: current.preview.revision,
      content: { _tag: "Entry", role: "assistant", text: current.preview.text },
    })
  }
  return result
}

export const units: {
  (view: ThreadView.ThreadViewSnapshot): (overlay: Overlay | undefined) => ReadonlyArray<TranscriptUnit.Unit>
  (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): ReadonlyArray<TranscriptUnit.Unit>
} = Function.dual(2, unitsImpl)

export const clearOverlay: {
  (turnId: string): (overlay: Overlay | undefined) => Overlay | undefined
  (overlay: Overlay | undefined, turnId: string): Overlay | undefined
} = Function.dual(2, (overlay: Overlay | undefined, turnId: string): Overlay | undefined =>
  overlay === undefined || overlay.turnId !== turnId ? overlay : undefined,
)
