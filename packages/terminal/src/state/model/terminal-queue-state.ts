import { Function } from "effect"
import type { Model } from "./terminal-state"
import type { QueueChange } from "./terminal-queue-change"
import type { QueueItem } from "./terminal-queue-item"
import type { ComposerDraft } from "./terminal-composer-state"

interface SubmittedDraft extends ComposerDraft {
  readonly cursor: number
  readonly submissionId?: string
  readonly turnId?: string
}

const bindSubmittedDraftImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  turnId: string,
  submissionId?: string,
): ReadonlyArray<SubmittedDraft> => {
  if (drafts.some((draft) => draft.turnId === turnId)) return drafts
  const index =
    submissionId === undefined
      ? drafts.findIndex((draft) => draft.turnId === undefined)
      : drafts.findIndex((draft) => draft.submissionId === submissionId && draft.turnId === undefined)
  if (index < 0) return drafts
  return drafts.map((draft, position) => (position === index ? { ...draft, turnId } : draft))
}

export const bindSubmittedDraft: {
  (
    arg0: Parameters<typeof bindSubmittedDraftImpl>[0],
    arg1: Parameters<typeof bindSubmittedDraftImpl>[1],
    arg2?: Parameters<typeof bindSubmittedDraftImpl>[2],
  ): ReturnType<typeof bindSubmittedDraftImpl>
  (
    arg1: Parameters<typeof bindSubmittedDraftImpl>[1],
  ): (arg0: Parameters<typeof bindSubmittedDraftImpl>[0]) => ReturnType<typeof bindSubmittedDraftImpl>
} = Function.dual((args) => args.length > 0, bindSubmittedDraftImpl)

const dropSubmittedDraftsImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  turnId: string | undefined,
): ReadonlyArray<SubmittedDraft> => (turnId === undefined ? [] : drafts.filter((draft) => draft.turnId !== turnId))

export const dropSubmittedDrafts: {
  (
    arg1: Parameters<typeof dropSubmittedDraftsImpl>[1],
  ): (arg0: Parameters<typeof dropSubmittedDraftsImpl>[0]) => ReturnType<typeof dropSubmittedDraftsImpl>
  (
    arg0: Parameters<typeof dropSubmittedDraftsImpl>[0],
    arg1: Parameters<typeof dropSubmittedDraftsImpl>[1],
  ): ReturnType<typeof dropSubmittedDraftsImpl>
} = Function.dual(2, dropSubmittedDraftsImpl)

const takeSubmittedDraftImpl = (
  drafts: ReadonlyArray<SubmittedDraft>,
  turnId: string | undefined,
): { readonly draft: SubmittedDraft | undefined; readonly rest: ReadonlyArray<SubmittedDraft> } => {
  const index = drafts.findIndex((draft) => turnId === undefined || draft.turnId === turnId)
  if (index < 0) return { draft: undefined, rest: drafts }
  return { draft: drafts[index], rest: drafts.filter((_, position) => position !== index) }
}

export const takeSubmittedDraft: {
  (
    arg1: Parameters<typeof takeSubmittedDraftImpl>[1],
  ): (arg0: Parameters<typeof takeSubmittedDraftImpl>[0]) => ReturnType<typeof takeSubmittedDraftImpl>
  (
    arg0: Parameters<typeof takeSubmittedDraftImpl>[0],
    arg1: Parameters<typeof takeSubmittedDraftImpl>[1],
  ): ReturnType<typeof takeSubmittedDraftImpl>
} = Function.dual(2, takeSubmittedDraftImpl)

const settleSteeringImpl = (
  model: Model,
  turnId: string | undefined,
): { readonly pendingSteering: ReadonlyArray<Model["pendingSteering"][number]>; readonly restoredInput?: string } => {
  const matching = model.pendingSteering.filter((row) => turnId === undefined || row.turnId === turnId)
  const pendingSteering = model.pendingSteering.filter((row) => !matching.includes(row))
  if (matching.length === 0 || model.input.length > 0) return { pendingSteering }
  return { pendingSteering, restoredInput: matching.map((row) => row.text).join("\n") }
}

export const settleSteering: {
  (
    arg1: Parameters<typeof settleSteeringImpl>[1],
  ): (arg0: Parameters<typeof settleSteeringImpl>[0]) => ReturnType<typeof settleSteeringImpl>
  (
    arg0: Parameters<typeof settleSteeringImpl>[0],
    arg1: Parameters<typeof settleSteeringImpl>[1],
  ): ReturnType<typeof settleSteeringImpl>
} = Function.dual(2, settleSteeringImpl)

const validQueueSelectionImpl = (current: string | undefined, queue: ReadonlyArray<QueueItem>): string | undefined =>
  current !== undefined && queue.some((item) => item.id === current) ? current : undefined
const exitEditWhenRemoved = (model: Model, queue: ReadonlyArray<QueueItem>): Partial<Model> => {
  if (model.editingTurnId === undefined || queue.some((item) => item.id === model.editingTurnId)) return {}
  const restore = model.editReturn ?? { input: "", attachments: [] }
  return {
    editingTurnId: undefined,
    editReturn: undefined,
    input: restore.input,
    cursor: restore.input.length,
    pastedText: [...restore.attachments],
  }
}

export const validQueueSelection: {
  (
    arg1: Parameters<typeof validQueueSelectionImpl>[1],
  ): (arg0: Parameters<typeof validQueueSelectionImpl>[0]) => ReturnType<typeof validQueueSelectionImpl>
  (
    arg0: Parameters<typeof validQueueSelectionImpl>[0],
    arg1: Parameters<typeof validQueueSelectionImpl>[1],
  ): ReturnType<typeof validQueueSelectionImpl>
} = Function.dual(2, validQueueSelectionImpl)

export const replaceQueue: {
  (model: Model, queue: ReadonlyArray<QueueItem>): Model
  (queue: ReadonlyArray<QueueItem>): (model: Model) => Model
} = Function.dual(
  2,
  (model: Model, queue: ReadonlyArray<QueueItem>): Model => ({
    ...model,
    queue: [...queue],
    queueSelection: validQueueSelection(model.queueSelection, queue),
  }),
)

export const resetQueue: {
  (model: Model, threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): Model
  (threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): (model: Model) => Model
} = Function.dual(
  4,
  (model: Model, threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): Model => ({
    ...model,
    queue: [...queue],
    queueThreadId: threadId,
    queueRevision: revision,
    queueSelection: validQueueSelection(model.queueSelection, queue),
    ...exitEditWhenRemoved(model, queue),
  }),
)

export const applyQueueDelta: {
  (
    model: Model,
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): { readonly model: Model; readonly resync: boolean }
  (
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): (model: Model) => { readonly model: Model; readonly resync: boolean }
} = Function.dual(
  (args) => typeof args[0] !== "string",
  (model: Model, threadId: string, revision: number, change: QueueChange, queuedCount?: number) => {
    if (model.currentThreadId !== undefined && model.currentThreadId !== threadId) return { model, resync: false }
    if (model.queueThreadId !== threadId || model.queueRevision === undefined) return { model, resync: true }
    if (revision <= model.queueRevision) return { model, resync: false }
    if (revision !== model.queueRevision + 1) return { model, resync: true }
    const queue = [...model.queue]
    let selection = model.queueSelection
    if (change._tag === "Added") {
      const existing = queue.findIndex((item) => item.id === change.item.id)
      if (existing >= 0 && queue[existing]!.provisional !== true) return { model, resync: true }
      if (existing >= 0) queue[existing] = change.item
      else queue.push(change.item)
    } else if (change._tag === "Updated") {
      const index = queue.findIndex((item) => item.id === change.item.id)
      if (index < 0) return { model, resync: true }
      queue[index] = change.item
    } else {
      const index = queue.findIndex((item) => item.id === change.turnId)
      if (index < 0) return { model, resync: true }
      queue.splice(index, 1)
      if (model.queueSelection === change.turnId) selection = queue[Math.min(index, queue.length - 1)]?.id
    }
    return {
      model: {
        ...model,
        queue,
        queueRevision: revision,
        queueSelection: validQueueSelection(selection, queue),
        ...exitEditWhenRemoved(model, queue),
      },
      resync: queuedCount !== undefined && queuedCount !== queue.length,
    }
  },
)
