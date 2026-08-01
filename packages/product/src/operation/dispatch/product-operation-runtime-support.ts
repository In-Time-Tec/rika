import * as TurnRepository from "@rika/product/turn-repository"
import type { InteractiveEvent } from "../interactive/interactive-event"
import { queueItem } from "../interactive/interactive-session-queue"

export const queueMutationEvent = (queue: TurnRepository.QueueItemChange): InteractiveEvent => ({
  _tag: "QueueUpdated",
  selectionEpoch: 0,
  threadId: queue.threadId,
  revision: queue.revision,
  queuedCount: queue.queuedCount,
  change:
    queue.change._tag === "Removed"
      ? { _tag: "Removed", turnId: queue.change.turnId }
      : { _tag: queue.change._tag, item: queueItem(queue.change.turn) },
})
