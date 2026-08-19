import * as InteractiveEvent from "@rika/product/interactive-event"
import { Function } from "effect"
import type { Model } from "@rika/terminal/terminal-state"
import { applyQueueDelta, resetQueue, update as updateModel } from "@rika/terminal/terminal-state-reducer"

type QueueEvent = Extract<
  InteractiveEvent.InteractiveEvent,
  { readonly _tag: "QueueUpdated" } | { readonly _tag: "QueueFull" }
>

export interface QueueUpdate {
  readonly model: Model
  readonly resync: boolean
}

const updateQueueImpl = (model: Model, event: QueueEvent): QueueUpdate => ({
  model: updateModel(model, {
    _tag: "SubmissionRejected",
    message: `Queue full: ${event.count} pending prompts`,
  }),
  resync: false,
})

export const updateQueue: {
  (event: QueueEvent): (model: Model) => QueueUpdate
  (model: Model, event: QueueEvent): QueueUpdate
} = Function.dual(2, updateQueueImpl)

const removePromotedTurnImpl = (model: Model, threadId: string, turnId: string): Model => {
  if (!model.queue.some((item) => item.id === turnId)) return model
  const revision = (model.queueRevision ?? 0) + 1
  const applied = applyQueueDelta(model, threadId, revision, { _tag: "Removed", turnId }, model.queue.length - 1)
  return applied.model.queue.some((item) => item.id === turnId)
    ? resetQueue(
        model,
        threadId,
        revision,
        model.queue.filter((item) => item.id !== turnId),
      )
    : applied.model
}

export const removePromotedTurn: {
  (threadId: string, turnId: string): (model: Model) => Model
  (model: Model, threadId: string, turnId: string): Model
} = Function.dual(3, removePromotedTurnImpl)
