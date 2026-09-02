import * as InteractiveEvent from "@rika/product/interactive-event"
import { Function } from "effect"
import type { Model } from "@rika/terminal/terminal-state"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"

type QueueEvent = Extract<
  InteractiveEvent.InteractiveEvent,
  { readonly _tag: "QueueUpdated" } | { readonly _tag: "QueueFull" }
>

interface QueueUpdate {
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
