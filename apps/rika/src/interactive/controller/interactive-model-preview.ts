import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as ThreadView from "@rika/product/thread-view"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Function } from "effect"

const maximumCharacters = ExecutionGateway.ModelPreviewMaxCharacters
const retiredIdentityCapacity = 16

export interface Overlay {
  readonly turnId: string
  readonly preview: ExecutionGateway.ModelPreviewed
  readonly identity: string
  readonly retiredIdentities: ReadonlyArray<string>
}

const identity = (preview: ExecutionGateway.ModelPreviewed): string =>
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

const bounded = (preview: ExecutionGateway.ModelPreviewed): ExecutionGateway.ModelPreviewed => {
  const text = preview.text.slice(0, maximumCharacters)
  const reasoning = preview.reasoning.slice(0, maximumCharacters - text.length)
  if (text === preview.text && reasoning === preview.reasoning) return preview
  return { ...preview, text, reasoning, truncated: true }
}

const replaceImpl = (
  current: Overlay | undefined,
  turnId: string,
  incoming: ExecutionGateway.ModelPreviewed,
): Overlay | undefined => {
  const preview = bounded(incoming)
  const nextIdentity = identity(preview)
  if (current === undefined || current.turnId !== turnId)
    return { turnId, preview, identity: nextIdentity, retiredIdentities: [] }
  if (current.retiredIdentities.includes(nextIdentity)) return current
  if (current.identity === nextIdentity)
    return preview.revision <= current.preview.revision ? current : { ...current, preview }
  if (compareAttempt(preview, current.preview) <= 0) return current
  return {
    turnId,
    preview,
    identity: nextIdentity,
    retiredIdentities: [current.identity, ...current.retiredIdentities].slice(0, retiredIdentityCapacity),
  }
}

export const replace: {
  (turnId: string, incoming: ExecutionGateway.ModelPreviewed): (current: Overlay | undefined) => Overlay | undefined
  (current: Overlay | undefined, turnId: string, incoming: ExecutionGateway.ModelPreviewed): Overlay | undefined
} = Function.dual(3, replaceImpl)

const semantic = (turn: ThreadView.ThreadViewTurn) => {
  let assistant = false
  let reasoning = false
  for (const unit of turn.units) {
    if (unit.content._tag === "Entry" && unit.content.role === "assistant") assistant = true
    if (unit.content._tag === "Block" && unit.content.block._tag === "Reasoning") reasoning = true
  }
  return { assistant, reasoning }
}

const terminal = (status: ThreadView.ThreadViewTurnRecord["status"]): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

const reconcileImpl = (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): Overlay | undefined => {
  if (overlay === undefined) return undefined
  const turn = view.turns.find((candidate) => String(candidate.turn.id) === overlay.turnId)
  if (turn === undefined || terminal(turn.turn.status)) return undefined
  const durable = semantic(turn)
  if (
    (overlay.preview.text.length === 0 || durable.assistant) &&
    (overlay.preview.reasoning.length === 0 || durable.reasoning)
  )
    return undefined
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
  const durable = semantic(turn)
  const result: Array<TranscriptUnit.Unit> = []
  const prefix = `tentative:${current.turnId}:${current.identity}`
  if (!durable.reasoning && current.preview.reasoning.length > 0) {
    const key = `${prefix}:reasoning`
    result.push({
      key,
      turnId: current.turnId,
      order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 0),
      revision: current.preview.revision,
      content: { _tag: "Block", block: { _tag: "Reasoning", text: current.preview.reasoning } },
    })
  }
  if (!durable.assistant && current.preview.text.length > 0) {
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
