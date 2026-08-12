import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as ThreadView from "@rika/product/thread-view"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Function } from "effect"

const retiredIdentityCapacity = 16
const utf8Encoder = new TextEncoder()

export interface Overlay {
  readonly turnId: string
  readonly preview: ExecutionGateway.ModelPreviewFrame | undefined
  readonly identity: string | undefined
  readonly reasoning: string
  readonly text: string
  readonly reasoningLength: number
  readonly textLength: number
  readonly reasoningBytes: number
  readonly textBytes: number
  readonly sequence: number
  readonly incomplete: boolean
  readonly retiredIdentities: ReadonlyArray<string>
  readonly clearFences: ReadonlyMap<string, number>
}

const identity = (preview: ExecutionGateway.ModelPreviewFrame): string =>
  JSON.stringify([
    preview.runId,
    preview.attemptFence,
    preview.turn,
    preview.modelCallId,
    preview.modelAttemptId,
    preview.attempt,
  ])

const startsWithLowSurrogate = (value: string): boolean => {
  const code = value.charCodeAt(0)
  return code >= 0xdc00 && code <= 0xdfff
}

const endsWithHighSurrogate = (value: string): boolean => {
  const code = value.charCodeAt(value.length - 1)
  return code >= 0xd800 && code <= 0xdbff
}

const appendedUtf8Bytes = (current: string, delta: string): number =>
  utf8Encoder.encode(delta).byteLength - (endsWithHighSurrogate(current) && startsWithLowSurrogate(delta) ? 2 : 0)

const appendChanges = (
  reasoning: string,
  text: string,
  reasoningLength: number,
  textLength: number,
  reasoningBytes: number,
  textBytes: number,
  changes: ReadonlyArray<ExecutionGateway.ModelPreviewChange>,
):
  | Pick<Overlay, "reasoning" | "text" | "reasoningLength" | "textLength" | "reasoningBytes" | "textBytes">
  | undefined => {
  for (const change of changes) {
    const offset = change.channel === "reasoning" ? reasoningLength : textLength
    if (change.offset !== offset) return undefined
    if (change.channel === "reasoning") {
      reasoningBytes += appendedUtf8Bytes(reasoning, change.delta)
      reasoning += change.delta
      reasoningLength += change.delta.length
    } else {
      textBytes += appendedUtf8Bytes(text, change.delta)
      text += change.delta
      textLength += change.delta.length
    }
  }
  return { reasoning, text, reasoningLength, textLength, reasoningBytes, textBytes }
}

const cleared = {
  reasoning: "",
  text: "",
  reasoningLength: 0,
  textLength: 0,
  reasoningBytes: 0,
  textBytes: 0,
} as const

const retire = (current: Overlay): ReadonlyArray<string> =>
  current.identity === undefined
    ? current.retiredIdentities
    : [current.identity, ...current.retiredIdentities.filter((value) => value !== current.identity)].slice(
        0,
        retiredIdentityCapacity,
      )

const rememberClear = (current: ReadonlyMap<string, number>, runId: string, attemptFence: number) => {
  const previous = current.get(runId)
  if (previous !== undefined && previous >= attemptFence) return current
  const next = new Map(current)
  if (previous === undefined && next.size >= retiredIdentityCapacity) next.delete(next.keys().next().value!)
  next.set(runId, attemptFence)
  return next
}

const replaceImpl = (
  current: Overlay | undefined,
  turnId: string,
  incoming: ExecutionGateway.ModelPreviewEvent,
): Overlay | undefined => {
  if (incoming._tag === "ModelPreviewCleared") {
    if (incoming.generation === 0) {
      if (
        current === undefined ||
        current.turnId !== turnId ||
        current.preview?.runId !== incoming.runId ||
        current.preview.attemptFence > incoming.attemptFence ||
        current.incomplete
      )
        return current
      return { ...current, ...cleared, incomplete: true }
    }
    if (current === undefined)
      return {
        turnId,
        preview: undefined,
        identity: undefined,
        ...cleared,
        sequence: -1,
        incomplete: true,
        retiredIdentities: [],
        clearFences: new Map([[incoming.runId, incoming.attemptFence]]),
      }
    if (current.turnId !== turnId) return current
    const clearFences = rememberClear(current.clearFences, incoming.runId, incoming.attemptFence)
    const invalidatesCurrent =
      current.preview?.runId === incoming.runId && current.preview.attemptFence <= incoming.attemptFence
    if (!invalidatesCurrent) return clearFences === current.clearFences ? current : { ...current, clearFences }
    if (current.incomplete && clearFences === current.clearFences) return current
    return {
      ...current,
      ...cleared,
      incomplete: true,
      clearFences,
    }
  }
  const preview = incoming
  const nextIdentity = identity(preview)
  const previous = current?.turnId === turnId ? current : undefined
  if ((previous?.clearFences.get(preview.runId) ?? Number.NEGATIVE_INFINITY) >= preview.attemptFence) return previous
  if (previous === undefined || previous.preview === undefined) {
    const appended = appendChanges("", "", 0, 0, 0, 0, preview.changes)
    return {
      turnId,
      preview,
      identity: nextIdentity,
      ...(preview.sequence === 0 && appended !== undefined ? appended : cleared),
      sequence: preview.sequence,
      incomplete: preview.sequence !== 0 || appended === undefined,
      retiredIdentities: previous?.retiredIdentities ?? [],
      clearFences: previous?.clearFences ?? new Map(),
    }
  }
  if (previous.retiredIdentities.includes(nextIdentity)) return previous
  if (previous.identity === nextIdentity) {
    if (preview.sequence <= previous.sequence || previous.incomplete) return previous
    if (preview.sequence !== previous.sequence + 1)
      return { ...previous, preview, ...cleared, sequence: preview.sequence, incomplete: true }
    const appended = appendChanges(
      previous.reasoning,
      previous.text,
      previous.reasoningLength,
      previous.textLength,
      previous.reasoningBytes,
      previous.textBytes,
      preview.changes,
    )
    return appended === undefined
      ? { ...previous, preview, ...cleared, sequence: preview.sequence, incomplete: true }
      : { ...previous, preview, ...appended, sequence: preview.sequence }
  }
  if (preview.runId === previous.preview.runId && preview.attemptFence < previous.preview.attemptFence) return previous
  const appended = appendChanges("", "", 0, 0, 0, 0, preview.changes)
  return {
    turnId,
    preview,
    identity: nextIdentity,
    ...(preview.sequence === 0 && appended !== undefined ? appended : cleared),
    sequence: preview.sequence,
    incomplete: preview.sequence !== 0 || appended === undefined,
    retiredIdentities: retire(previous),
    clearFences: previous.clearFences,
  }
}

export const replace: {
  (turnId: string, incoming: ExecutionGateway.ModelPreviewEvent): (current: Overlay | undefined) => Overlay | undefined
  (current: Overlay | undefined, turnId: string, incoming: ExecutionGateway.ModelPreviewEvent): Overlay | undefined
} = Function.dual(3, replaceImpl)

const terminal = (status: ThreadView.ThreadViewTurnRecord["status"]): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

const reconcileImpl = (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): Overlay | undefined => {
  if (overlay === undefined) return undefined
  const turn = view.turns.find((candidate) => String(candidate.turn.id) === overlay.turnId)
  if (turn === undefined || terminal(turn.turn.status)) return undefined
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
  if (current.identity === undefined) return []
  const result: Array<TranscriptUnit.Unit> = []
  const prefix = `tentative:${current.turnId}:${current.identity}`
  if (current.reasoning.length > 0) {
    const key = `${prefix}:reasoning`
    result.push({
      key,
      turnId: current.turnId,
      order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 0),
      revision: current.sequence,
      content: { _tag: "Block", block: { _tag: "Reasoning", text: current.reasoning } },
    })
  }
  if (current.text.length > 0) {
    const key = `${prefix}:assistant`
    result.push({
      key,
      turnId: current.turnId,
      order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 1),
      revision: current.sequence,
      content: { _tag: "Entry", role: "assistant", text: current.text },
    })
  }
  return result
}

export const units: {
  (view: ThreadView.ThreadViewSnapshot): (overlay: Overlay | undefined) => ReadonlyArray<TranscriptUnit.Unit>
  (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): ReadonlyArray<TranscriptUnit.Unit>
} = Function.dual(2, unitsImpl)
