import * as TurnQueuePromotion from "../../thread/repository/turn-queue"
import type { InteractiveEvent } from "../interactive/session-event"
import { queueItem } from "../interactive/turn/queue"

export const queueMutationEvent = (queue: TurnQueuePromotion.QueueItemChange): InteractiveEvent => {
  let change: Extract<InteractiveEvent, { readonly _tag: "QueueUpdated" }>["change"]
  if (queue.change._tag === "Removed") change = { _tag: "Removed", turnId: queue.change.turnId }
  else if (queue.change._tag === "Added" && queue.change.position !== undefined)
    change = { _tag: queue.change._tag, item: queueItem(queue.change.turn), position: queue.change.position }
  else change = { _tag: queue.change._tag, item: queueItem(queue.change.turn) }
  return {
    _tag: "QueueUpdated",
    selectionEpoch: 0,
    threadId: queue.threadId,
    revision: queue.revision,
    queuedCount: queue.queuedCount,
    change,
  }
}
