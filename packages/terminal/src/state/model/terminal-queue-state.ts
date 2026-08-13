import { Function } from "effect"
import type { Model } from "./terminal-state"
import type { QueueChange } from "./terminal-queue-change"
import type { QueueItem } from "./terminal-queue-item"

export * from "./terminal-submitted-draft"

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

export interface QueueDeltaResult {
  readonly model: Model
  readonly resync: boolean
}

export const applyQueueDelta: {
  (model: Model, threadId: string, revision: number, change: QueueChange, queuedCount?: number): QueueDeltaResult
  (threadId: string, revision: number, change: QueueChange, queuedCount?: number): (model: Model) => QueueDeltaResult
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
      else queue.splice(Math.min(change.position ?? queue.length, queue.length), 0, change.item)
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
