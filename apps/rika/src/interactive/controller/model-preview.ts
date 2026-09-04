import * as ExecutionGateway from "@rika/product/execution-gateway"
import type * as ThreadView from "@rika/product/thread-view"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Function } from "effect"

const retiredIdentityCapacity = 16
const utf8Encoder = new TextEncoder()

interface RunOverlay {
  readonly preview: ExecutionGateway.ModelPreviewFrame | undefined
  readonly identity: string | undefined
  readonly responseId: string | undefined
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
  let nextReasoning = reasoning
  let nextText = text
  let nextReasoningLength = reasoningLength
  let nextTextLength = textLength
  let nextReasoningBytes = reasoningBytes
  let nextTextBytes = textBytes
  for (const change of changes) {
    const offset = change.channel === "reasoning" ? nextReasoningLength : nextTextLength
    if (change.offset !== offset) return undefined
    if (change.channel === "reasoning") {
      nextReasoningBytes += appendedUtf8Bytes(nextReasoning, change.delta)
      nextReasoning += change.delta
      nextReasoningLength += change.delta.length
    } else {
      nextTextBytes += appendedUtf8Bytes(nextText, change.delta)
      nextText += change.delta
      nextTextLength += change.delta.length
    }
  }
  return {
    reasoning: nextReasoning,
    text: nextText,
    reasoningLength: nextReasoningLength,
    textLength: nextTextLength,
    reasoningBytes: nextReasoningBytes,
    textBytes: nextTextBytes,
  }
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

const clearRun = (
  current: RunOverlay | undefined,
  incoming: Extract<ExecutionGateway.ModelPreviewEvent, { readonly _tag: "ModelPreviewCleared" }>,
): RunOverlay | undefined => {
  if (incoming.generation === 0) {
    if (
      current === undefined ||
      current.preview === undefined ||
      current.preview.attemptFence > incoming.attemptFence ||
      current.incomplete
    )
      return current
    return { ...current, incomplete: true }
  }
  const clearFence = Math.max(current?.clearFence ?? Number.NEGATIVE_INFINITY, incoming.attemptFence)
  if (current === undefined)
    return {
      preview: undefined,
      identity: undefined,
      responseId: undefined,
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

const initializeRun = (
  current: RunOverlay | undefined,
  preview: ExecutionGateway.ModelPreviewFrame,
  nextIdentity: string,
): RunOverlay => {
  const appended = appendChanges("", "", 0, 0, 0, 0, preview.changes)
  const content = preview.sequence === 0 && appended !== undefined ? appended : cleared
  return {
    preview,
    identity: nextIdentity,
    responseId: ExecutionGateway.modelResponseId(preview),
    ...content,
    sequence: preview.sequence,
    incomplete: preview.sequence !== 0 || appended === undefined,
    retiredIdentities: current?.retiredIdentities ?? [],
    clearFence: current?.clearFence,
  }
}

const appendFrame = (current: RunOverlay, preview: ExecutionGateway.ModelPreviewFrame): RunOverlay => {
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
    : {
        ...current,
        preview,
        ...appended,
        sequence: preview.sequence,
      }
}

const replaceRun = (
  current: RunOverlay | undefined,
  incoming: ExecutionGateway.ModelPreviewEvent,
): RunOverlay | undefined => {
  if (incoming._tag === "ModelPreviewCleared") return clearRun(current, incoming)
  if (incoming._tag === "ModelPreviewUsage") return current
  const preview = incoming
  const nextIdentity = identity(preview)
  if ((current?.clearFence ?? Number.NEGATIVE_INFINITY) >= preview.attemptFence) return current
  if (current === undefined || current.preview === undefined) return initializeRun(current, preview, nextIdentity)
  if (current.retiredIdentities.includes(nextIdentity)) return current
  if (current.identity === nextIdentity) {
    if (preview.sequence <= current.sequence || current.incomplete) return current
    return appendFrame(current, preview)
  }
  if (preview.attemptFence < current.preview.attemptFence) return current
  return initializeRun({ ...current, retiredIdentities: retire(current) }, preview, nextIdentity)
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

const reconcileImpl = (overlay: Overlay | undefined, view: ThreadView.ThreadViewAccumulator): Overlay | undefined => {
  if (overlay === undefined) return undefined
  const turn = view.turn(overlay.turnId)
  if (turn === undefined || turn.turn.status === "failed" || turn.turn.status === "cancelled") return undefined
  // Completion can arrive before the final projection. Only a matching durable
  // response replaces its preview; the status record alone contains no answer.
  const durableResponseIds = new Set(
    view.units(overlay.turnId).flatMap((unit) => (unit.modelResponseId === undefined ? [] : [unit.modelResponseId])),
  )
  if (durableResponseIds.size === 0) return overlay
  let changed = false
  const byRun = new Map<string, RunOverlay>()
  for (const [runId, run] of overlay.byRun) {
    if (run.responseId === undefined || !durableResponseIds.has(run.responseId)) {
      byRun.set(runId, run)
      continue
    }
    if (run.preview === undefined) {
      byRun.set(runId, run)
      continue
    }
    changed = true
    byRun.set(runId, { ...run, preview: undefined, identity: undefined, ...cleared, incomplete: true })
  }
  if (turn.turn.status === "completed" && [...byRun.values()].every((run) => run.preview === undefined))
    return undefined
  if (!changed) return overlay
  return byRun.size === 0 ? undefined : { ...overlay, byRun }
}

export const reconcile: {
  (view: ThreadView.ThreadViewAccumulator): (overlay: Overlay | undefined) => Overlay | undefined
  (overlay: Overlay | undefined, view: ThreadView.ThreadViewAccumulator): Overlay | undefined
} = Function.dual(2, reconcileImpl)

const activityImpl = (overlay: Overlay | undefined, turnId: string) => {
  if (overlay?.turnId !== turnId) return undefined
  const runs = [...overlay.byRun.values()]
  const text = runs.filter((run) => run.textBytes > 0)
  if (text.length > 0) {
    return {
      _tag: "Streaming" as const,
      bytes: text.reduce((total, run) => total + run.textBytes, 0),
      active: true,
    }
  }
  const reasoning = runs.filter((run) => run.reasoningBytes > 0)
  if (reasoning.length > 0) {
    return {
      _tag: "Thinking" as const,
      bytes: reasoning.reduce((total, run) => total + run.reasoningBytes, 0),
      active: true,
    }
  }
  return undefined
}

export const activity: {
  (turnId: string): (overlay: Overlay | undefined) => ReturnType<typeof activityImpl>
  (overlay: Overlay | undefined, turnId: string): ReturnType<typeof activityImpl>
} = Function.dual(2, activityImpl)

const unitsImpl = (
  overlay: Overlay | undefined,
  view: ThreadView.ThreadViewAccumulator,
): ReadonlyArray<TranscriptUnit.Unit> => {
  const current = reconcile(overlay, view)
  if (current === undefined) return []
  const turn = view.turn(current.turnId)
  if (turn === undefined) return []
  const result: Array<TranscriptUnit.Unit> = []
  for (const preview of current.byRun.values()) {
    if (preview.identity === undefined) continue
    const prefix = `tentative:${current.turnId}:${preview.identity}`
    const parentId = preview.preview?.parentId
    if (preview.reasoning.length > 0) {
      const key = `${prefix}:reasoning`
      const unit: TranscriptUnit.Unit =
        parentId === undefined
          ? {
              key,
              turnId: current.turnId,
              order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 0),
              revision: preview.sequence,
              content: { _tag: "Block", block: { _tag: "Reasoning", text: preview.reasoning } },
            }
          : {
              key,
              turnId: current.turnId,
              parentId,
              order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 0),
              revision: preview.sequence,
              content: { _tag: "Block", block: { _tag: "Reasoning", text: preview.reasoning } },
            }
      result.push(unit)
    }
    if (preview.text.length > 0) {
      const key = `${prefix}:assistant`
      const unit: TranscriptUnit.Unit =
        parentId === undefined
          ? {
              key,
              turnId: current.turnId,
              order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 1),
              revision: preview.sequence,
              content: { _tag: "Entry", role: "assistant", text: preview.text },
            }
          : {
              key,
              turnId: current.turnId,
              parentId,
              order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER, 1),
              revision: preview.sequence,
              content: { _tag: "Entry", role: "assistant", text: preview.text },
            }
      result.push(unit)
    }
  }
  return result
}

export const units: {
  (view: ThreadView.ThreadViewAccumulator): (overlay: Overlay | undefined) => ReadonlyArray<TranscriptUnit.Unit>
  (overlay: Overlay | undefined, view: ThreadView.ThreadViewAccumulator): ReadonlyArray<TranscriptUnit.Unit>
} = Function.dual(2, unitsImpl)
