import { Function, Predicate } from "effect"
import type { Model } from "./model"
import type { TranscriptItem } from "./transcript/model"

type SubmissionItem = Extract<TranscriptItem, { readonly _tag: "Entry" }> & {
  readonly submissionId?: string
  readonly provisional?: boolean
}

interface ReconcileResult {
  readonly model: Model
  readonly found: boolean
}

interface ProvisionalSubmissionItem {
  _tag: "Entry"
  index: number
  id: string
  provisional: true
  submissionId?: string
}

type MutableSubmissionItem = { -readonly [Key in keyof SubmissionItem]: SubmissionItem[Key] }

export interface SubmissionReference {
  readonly submissionId?: string
  readonly turnId?: string
}

const isSubmissionItem = (item: Model["items"][number]): item is SubmissionItem =>
  Predicate.hasProperty(item, "_tag") &&
  item._tag === "Entry" &&
  Predicate.hasProperty(item, "index") &&
  Predicate.isNumber(item.index)

const itemMatches = (item: SubmissionItem, reference: SubmissionReference): boolean => {
  if (item._tag !== "Entry") return false
  if (reference.submissionId !== undefined && item.submissionId === reference.submissionId) return true
  if (reference.turnId !== undefined && item.turnId === reference.turnId) return true
  return reference.submissionId === undefined && item.provisional === true && item.turnId === undefined
}

const itemPosition = (model: Model, reference: SubmissionReference, provisionalOnly: boolean): number =>
  model.items.findIndex(
    (item) => isSubmissionItem(item) && (!provisionalOnly || item.provisional === true) && itemMatches(item, reference),
  )

const appendProvisionalUserEntryImpl = (model: Model, prompt: string, submissionId?: string): Model => {
  const index = model.entries.length
  const localId = submissionId ?? `${model.history.length}:${model.submittedDrafts.length}:${index}`
  const item: ProvisionalSubmissionItem = { _tag: "Entry", index, id: `submission:${localId}:user`, provisional: true }
  if (submissionId !== undefined) item.submissionId = submissionId
  return {
    ...model,
    entries: [...model.entries, { role: "user", text: prompt }],
    items: [...model.items, item],
  }
}

const reconcileUserEntryImpl = (
  model: Model,
  reference: SubmissionReference & { readonly prompt?: string; readonly started: boolean },
): ReconcileResult => {
  const position = itemPosition(model, reference, false)
  if (position < 0) return { model, found: false }
  const item = model.items[position]
  if (!isSubmissionItem(item)) return { model, found: false }
  const entry = model.entries[item.index]
  if (entry?.role !== "user") return { model, found: false }
  const turnId = reference.turnId ?? item.turnId
  const entries = [...model.entries]
  const reconciledEntry = { ...entry }
  if (reference.prompt !== undefined) reconciledEntry.text = reference.prompt
  if (turnId !== undefined) reconciledEntry.turnId = turnId
  entries[item.index] = reconciledEntry
  const items = [...model.items]
  const { provisional: _, ...settledItem } = item
  const reconciledItem: MutableSubmissionItem = { ...settledItem }
  if (turnId !== undefined) {
    reconciledItem.id = `turn:${turnId}:user`
    reconciledItem.turnId = turnId
  }
  if (reference.submissionId !== undefined) reconciledItem.submissionId = reference.submissionId
  if (!reference.started && item.provisional === true) reconciledItem.provisional = true
  items[position] = reconciledItem
  return { model: { ...model, entries, items }, found: true }
}

const hasProvisionalUserEntryImpl = (model: Model, reference: SubmissionReference): boolean =>
  itemPosition(model, reference, true) >= 0

const settleProvisionalUserEntryImpl = (model: Model, reference: SubmissionReference, restore: boolean): Model => {
  const position = itemPosition(model, reference, true)
  if (position < 0) return model
  const item = model.items[position]
  if (!isSubmissionItem(item)) return model
  if (!restore) {
    const { provisional: _, ...settled } = item
    const items = [...model.items]
    items[position] = settled
    return { ...model, items }
  }
  const entries = model.entries.filter((_, index) => index !== item.index)
  const items = model.items.flatMap((candidate, index) => {
    if (index === position) return []
    if (!isSubmissionItem(candidate) || candidate.index < item.index) return [candidate]
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
} = Function.dual((args) => !Predicate.isString(args[0]), appendProvisionalUserEntryImpl)

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

const overlayProvisionalTranscript = (model: Model, previous: Model) => {
  let entries: Model["entries"] = model.entries
  let items: Model["items"] = model.items
  let mutableEntries: Array<Model["entries"][number]> | undefined
  let mutableItems: Array<Model["items"][number]> | undefined
  for (const item of previous.items) {
    if (!isSubmissionItem(item) || item.provisional !== true) continue
    if (items.some((candidate) => isSubmissionItem(candidate) && itemMatches(candidate, item))) continue
    const entry = previous.entries[item.index]
    if (entry === undefined) continue
    const previousCount = previous.entries.filter(
      (candidate) => candidate.role === entry.role && candidate.text === entry.text,
    ).length
    const currentCount = entries.filter(
      (candidate) => candidate.role === entry.role && candidate.text === entry.text,
    ).length
    if (currentCount >= previousCount) continue
    if (mutableEntries === undefined || mutableItems === undefined) {
      mutableEntries = Array.from(entries)
      mutableItems = Array.from(items)
      entries = mutableEntries
      items = mutableItems
    }
    const index = mutableEntries.length
    mutableEntries.push(entry)
    mutableItems.push({ ...item, index })
  }
  return { entries, items, changed: mutableEntries !== undefined }
}

export const overlayPendingSubmissions: {
  (arg0: Model, arg1: Model): Model
  (arg1: Model): (arg0: Model) => Model
} = Function.dual(2, (model: Model, previous: Model): Model => {
  const transcript = overlayProvisionalTranscript(model, previous)
  const missingQueue = previous.queue.filter(
    (item) => item.provisional === true && !model.queue.some((candidate) => candidate.id === item.id),
  )
  const queue = missingQueue.length === 0 ? model.queue : [...model.queue, ...missingQueue]
  const restoreSending =
    previous.busy && !model.busy && previous.submittedDrafts.some((draft) => draft.turnId === undefined)
  const queueSelection = queue.some((item) => item.id === model.queueSelection)
    ? model.queueSelection
    : queue.at(-1)?.id
  const overlaid =
    transcript.changed || queue !== model.queue || queueSelection !== model.queueSelection
      ? { ...model, entries: transcript.entries, items: transcript.items, queue, queueSelection }
      : model
  if (!restoreSending) return overlaid
  return { ...overlaid, busy: true, activity: previous.activity ?? { _tag: "Sending" as const } }
})
