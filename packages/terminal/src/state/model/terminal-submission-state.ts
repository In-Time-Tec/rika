import { Function } from "effect"
import type { Model } from "./terminal-state"
import type { TranscriptItem } from "./terminal-transcript-state"
import { expandPastedText } from "./terminal-composer-paste"

type SubmissionItem = TranscriptItem & {
  readonly submissionId?: string
  readonly provisional?: boolean
}

export interface SubmissionReference {
  readonly submissionId?: string
  readonly turnId?: string
}

const itemMatches = (item: SubmissionItem, reference: SubmissionReference): boolean => {
  if (item._tag !== "Entry") return false
  if (reference.submissionId !== undefined && item.submissionId === reference.submissionId) return true
  if (reference.turnId !== undefined && item.turnId === reference.turnId) return true
  return reference.submissionId === undefined && item.provisional === true && item.turnId === undefined
}

const itemPosition = (model: Model, reference: SubmissionReference, provisionalOnly: boolean): number =>
  (model.items as ReadonlyArray<SubmissionItem>).findIndex(
    (item) => (!provisionalOnly || item.provisional === true) && itemMatches(item, reference),
  )

const appendProvisionalUserEntryImpl = (model: Model, prompt: string, submissionId?: string): Model => {
  const index = model.entries.length
  const localId = submissionId ?? `${model.history.length}:${model.submittedDrafts.length}:${index}`
  return {
    ...model,
    entries: [...model.entries, { role: "user", text: prompt }],
    items: [
      ...model.items,
      {
        _tag: "Entry",
        index,
        id: `submission:${localId}:user`,
        ...(submissionId === undefined ? {} : { submissionId }),
        provisional: true,
      },
    ],
  }
}

const reconcileUserEntryImpl = (
  model: Model,
  reference: SubmissionReference & { readonly prompt?: string; readonly started: boolean },
): { readonly model: Model; readonly found: boolean } => {
  const position = itemPosition(model, reference, false)
  if (position < 0) return { model, found: false }
  const item = (model.items as ReadonlyArray<SubmissionItem>)[position]
  if (item?._tag !== "Entry") return { model, found: false }
  const entry = model.entries[item.index]
  if (entry?.role !== "user") return { model, found: false }
  const turnId = reference.turnId ?? item.turnId
  const entries = [...model.entries]
  entries[item.index] = {
    ...entry,
    ...(reference.prompt === undefined ? {} : { text: reference.prompt }),
    ...(turnId === undefined ? {} : { turnId }),
  }
  const items = [...(model.items as ReadonlyArray<SubmissionItem>)]
  const { provisional: _, ...settledItem } = item
  items[position] = {
    ...settledItem,
    ...(turnId === undefined ? {} : { id: `turn:${turnId}:user`, turnId }),
    ...(reference.submissionId === undefined ? {} : { submissionId: reference.submissionId }),
    ...(reference.started || item.provisional !== true ? {} : { provisional: true }),
  }
  return { model: { ...model, entries, items }, found: true }
}

const hasProvisionalUserEntryImpl = (model: Model, reference: SubmissionReference): boolean =>
  itemPosition(model, reference, true) >= 0

const settleProvisionalUserEntryImpl = (model: Model, reference: SubmissionReference, restore: boolean): Model => {
  const position = itemPosition(model, reference, true)
  if (position < 0) return model
  const item = (model.items as ReadonlyArray<SubmissionItem>)[position]
  if (item?._tag !== "Entry") return model
  if (!restore) {
    const { provisional: _, ...settled } = item
    const items = [...(model.items as ReadonlyArray<SubmissionItem>)]
    items[position] = settled
    return { ...model, items }
  }
  const entries = model.entries.filter((_, index) => index !== item.index)
  const items = (model.items as ReadonlyArray<SubmissionItem>).flatMap((candidate, index) => {
    if (index === position) return []
    if (candidate._tag !== "Entry" || candidate.index < item.index) return [candidate]
    return [{ ...candidate, index: candidate.index - 1 }]
  })
  return { ...model, entries, items }
}

export const appendProvisionalUserEntry: {
  (
    arg0: Parameters<typeof appendProvisionalUserEntryImpl>[0],
    arg1: Parameters<typeof appendProvisionalUserEntryImpl>[1],
    arg2?: Parameters<typeof appendProvisionalUserEntryImpl>[2],
  ): ReturnType<typeof appendProvisionalUserEntryImpl>
  (
    arg1: Parameters<typeof appendProvisionalUserEntryImpl>[1],
    arg2?: Parameters<typeof appendProvisionalUserEntryImpl>[2],
  ): (arg0: Parameters<typeof appendProvisionalUserEntryImpl>[0]) => ReturnType<typeof appendProvisionalUserEntryImpl>
} = Function.dual((args) => typeof args[0] !== "string", appendProvisionalUserEntryImpl)

export const reconcileUserEntry: {
  (
    arg1: Parameters<typeof reconcileUserEntryImpl>[1],
  ): (arg0: Parameters<typeof reconcileUserEntryImpl>[0]) => ReturnType<typeof reconcileUserEntryImpl>
  (
    arg0: Parameters<typeof reconcileUserEntryImpl>[0],
    arg1: Parameters<typeof reconcileUserEntryImpl>[1],
  ): ReturnType<typeof reconcileUserEntryImpl>
} = Function.dual(2, reconcileUserEntryImpl)

export const hasProvisionalUserEntry: {
  (
    arg1: Parameters<typeof hasProvisionalUserEntryImpl>[1],
  ): (arg0: Parameters<typeof hasProvisionalUserEntryImpl>[0]) => ReturnType<typeof hasProvisionalUserEntryImpl>
  (
    arg0: Parameters<typeof hasProvisionalUserEntryImpl>[0],
    arg1: Parameters<typeof hasProvisionalUserEntryImpl>[1],
  ): ReturnType<typeof hasProvisionalUserEntryImpl>
} = Function.dual(2, hasProvisionalUserEntryImpl)

export const settleProvisionalUserEntry: {
  (
    arg1: Parameters<typeof settleProvisionalUserEntryImpl>[1],
    arg2: Parameters<typeof settleProvisionalUserEntryImpl>[2],
  ): (arg0: Parameters<typeof settleProvisionalUserEntryImpl>[0]) => ReturnType<typeof settleProvisionalUserEntryImpl>
  (
    arg0: Parameters<typeof settleProvisionalUserEntryImpl>[0],
    arg1: Parameters<typeof settleProvisionalUserEntryImpl>[1],
    arg2: Parameters<typeof settleProvisionalUserEntryImpl>[2],
  ): ReturnType<typeof settleProvisionalUserEntryImpl>
} = Function.dual(3, settleProvisionalUserEntryImpl)

/**
 * A server ThreadView snapshot/patch rebuilds the transcript from authoritative units. Pending local
 * submissions have no authoritative unit until admission and TurnStarted, so every rebuild must
 * re-overlay their provisional rows and queue items; otherwise an unrelated header-only patch makes
 * an echoed prompt disappear until the durable prompt unit arrives.
 */
export const overlayPendingSubmissions: {
  (arg0: Model, arg1: Model): Model
  (arg1: Model): (arg0: Model) => Model
} = Function.dual(2, (model: Model, previous: Model): Model => {
  let next = model
  const queue = [...next.queue]
  for (const item of previous.queue) {
    if (item.provisional === true && !queue.some((candidate) => candidate.id === item.id)) queue.push(item)
  }
  for (const draft of previous.submittedDrafts) {
    const bound = draft.turnId !== undefined
    const authoritative = bound && next.entries.some((entry) => entry.role === "user" && entry.turnId === draft.turnId)
    if (authoritative) continue
    next = appendProvisionalUserEntry(next, expandPastedText(draft.input, draft.attachments), draft.submissionId)
  }
  if (queue.length === next.queue.length) return next
  return {
    ...next,
    queue,
    queueSelection: queue.some((item) => item.id === next.queueSelection) ? next.queueSelection : queue.at(-1)?.id,
  }
})
