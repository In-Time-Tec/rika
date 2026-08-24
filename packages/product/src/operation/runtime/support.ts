import * as TurnQueuePromotion from "../../thread/repository/turn-queue"
import type { InteractiveEvent } from "../interactive/session-event"
import { queueItem } from "../interactive/turn/queue"

export const queueMutationEvent = (queue: TurnQueuePromotion.QueueItemChange): InteractiveEvent => ({
  _tag: "QueueUpdated",
  selectionEpoch: 0,
  threadId: queue.threadId,
  revision: queue.revision,
  queuedCount: queue.queuedCount,
  change:
    queue.change._tag === "Removed"
      ? { _tag: "Removed", turnId: queue.change.turnId }
      : {
          _tag: queue.change._tag,
          item: queueItem(queue.change.turn),
          ...(queue.change._tag === "Added" && queue.change.position !== undefined
            ? { position: queue.change.position }
            : {}),
        },
})
