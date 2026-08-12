import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as ThreadView from "@rika/product/thread-view"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Function } from "effect"

const retiredIdentityCapacity = 16
const utf8Encoder = new TextEncoder()

export interface RunOverlay {
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
  readonly clearFence: number | undefined
}

export interface Overlay {
  readonly turnId: string
  readonly byRun: ReadonlyMap<string, RunOverlay>
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
  | Pick<RunOverlay, "reasoning" | "text" | "reasoningLength" | "textLength" | "reasoningBytes" | "textBytes">
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

const retire = (current: RunOverlay): ReadonlyArray<string> =>
  current.identity === undefined
    ? current.retiredIdentities
    : [current.identity, ...current.retiredIdentities.filter((value) => value !== current.identity)].slice(
        0,
        retiredIdentityCapacity,
      )

const replaceRun = (
  current: RunOverlay | undefined,
  incoming: ExecutionGateway.ModelPreviewEvent,
): RunOverlay | undefined => {
  if (incoming._tag === "ModelPreviewCleared") {
    if (incoming.generation === 0) {
      if (
        current === undefined ||
        current.preview === undefined ||
        current.preview.attemptFence > incoming.attemptFence ||
        current.incomplete
      )
        return current
      return { ...current, ...cleared, incomplete: true }
    }
    const clearFence = Math.max(current?.clearFence ?? Number.NEGATIVE_INFINITY, incoming.attemptFence)
    if (current === undefined)
      return {
        preview: undefined,
        identity: undefined,
        ...cleared,
        sequence: -1,
        incomplete: true,
        retiredIdentities: [],
        clearFence,
      }
    const invalidatesCurrent = current.preview !== undefined && current.preview.attemptFence <= incoming.attemptFence
    if (!invalidatesCurrent) return clearFence === current.clearFence ? current : { ...current, clearFence }
    if (current.incomplete && clearFence === current.clearFence) return current
    return {
      ...current,
      ...cleared,
      incomplete: true,
      clearFence,
    }
  }
  const preview = incoming
  const nextIdentity = identity(preview)
  if ((current?.clearFence ?? Number.NEGATIVE_INFINITY) >= preview.attemptFence) return current
  if (current === undefined || current.preview === undefined) {
    const appended = appendChanges("", "", 0, 0, 0, 0, preview.changes)
    return {
      preview,
      identity: nextIdentity,
      ...(preview.sequence === 0 && appended !== undefined ? appended : cleared),
      sequence: preview.sequence,
      incomplete: preview.sequence !== 0 || appended === undefined,
      retiredIdentities: current?.retiredIdentities ?? [],
      clearFence: current?.clearFence,
    }
  }
  if (current.retiredIdentities.includes(nextIdentity)) return current
  if (current.identity === nextIdentity) {
    if (preview.sequence <= current.sequence || current.incomplete) return current
    if (preview.sequence !== current.sequence + 1)
      return { ...current, preview, ...cleared, sequence: preview.sequence, incomplete: true }
    const appended = appendChanges(
      current.reasoning,
      current.text,
      current.reasoningLength,
      current.textLength,
      current.reasoningBytes,
      current.textBytes,
      preview.changes,
    )
    return appended === undefined
      ? { ...current, preview, ...cleared, sequence: preview.sequence, incomplete: true }
      : { ...current, preview, ...appended, sequence: preview.sequence }
  }
  if (preview.attemptFence < current.preview.attemptFence) return current
  const appended = appendChanges("", "", 0, 0, 0, 0, preview.changes)
  return {
    preview,
    identity: nextIdentity,
    ...(preview.sequence === 0 && appended !== undefined ? appended : cleared),
    sequence: preview.sequence,
    incomplete: preview.sequence !== 0 || appended === undefined,
    retiredIdentities: retire(current),
    clearFence: current.clearFence,
  }
}

const replaceImpl = (
  current: Overlay | undefined,
  turnId: string,
  incoming: ExecutionGateway.ModelPreviewEvent,
): Overlay | undefined => {
  const previous = current?.turnId === turnId ? current : undefined
  const before = previous?.byRun.get(incoming.runId)
  const after = replaceRun(before, incoming)
  if (after === before) return previous
  if (after === undefined) return previous
  const byRun = new Map(previous?.byRun)
  byRun.set(incoming.runId, after)
  return { turnId, byRun }
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

const activityImpl = (overlay: Overlay | undefined, turnId: string) => {
  if (overlay?.turnId !== turnId) return undefined
  let textBytes = 0
  let reasoningBytes = 0
  for (const preview of overlay.byRun.values()) {
    textBytes += preview.textBytes
    reasoningBytes += preview.reasoningBytes
  }
  return { textBytes, reasoningBytes }
}

export const activity: {
  (turnId: string): (overlay: Overlay | undefined) => ReturnType<typeof activityImpl>
  (overlay: Overlay | undefined, turnId: string): ReturnType<typeof activityImpl>
} = Function.dual(2, activityImpl)

const unitsImpl = (
  overlay: Overlay | undefined,
  view: ThreadView.ThreadViewSnapshot,
): ReadonlyArray<TranscriptUnit.Unit> => {
  const current = reconcile(overlay, view)
  if (current === undefined) return []
  const turn = view.turns.find((candidate) => String(candidate.turn.id) === current.turnId)
  if (turn === undefined) return []
  const result: Array<TranscriptUnit.Unit> = []
  for (const preview of current.byRun.values()) {
    if (preview.identity === undefined) continue
    const prefix = `tentative:${current.turnId}:${preview.identity}`
    const parentId = preview.preview?.parentId
    if (preview.reasoning.length > 0) {
      const key = `${prefix}:reasoning`
      result.push({
        key,
        turnId: current.turnId,
        ...(parentId === undefined ? {} : { parentId }),
        order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 0),
        revision: preview.sequence,
        content: { _tag: "Block", block: { _tag: "Reasoning", text: preview.reasoning } },
      })
    }
    if (preview.text.length > 0) {
      const key = `${prefix}:assistant`
      result.push({
        key,
        turnId: current.turnId,
        ...(parentId === undefined ? {} : { parentId }),
        order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 1),
        revision: preview.sequence,
        content: { _tag: "Entry", role: "assistant", text: preview.text },
      })
    }
  }
  return result
}

export const units: {
  (view: ThreadView.ThreadViewSnapshot): (overlay: Overlay | undefined) => ReadonlyArray<TranscriptUnit.Unit>
  (overlay: Overlay | undefined, view: ThreadView.ThreadViewSnapshot): ReadonlyArray<TranscriptUnit.Unit>
} = Function.dual(2, unitsImpl)
