import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import * as Thread from "@rika/product/thread-record"

export const eventForSequenceGap = (
  event: InteractiveEvent.InteractiveEvent,
): InteractiveEvent.InteractiveEvent | undefined => {
  if (event._tag === "ResyncRequired") return event
  if (event._tag === "ThreadViewSnapshot")
    return ThreadView.ResyncRequired.make({
      threadId: event.snapshot.thread.id,
      expectedRevision: event.snapshot.revision,
      receivedBaseRevision: event.snapshot.revision,
      currentRevision: event.snapshot.revision,
    })
  if (event._tag === "ThreadViewPatch")
    return ThreadView.ResyncRequired.make({
      threadId: event.patch.threadId,
      expectedRevision: event.patch.revision,
      receivedBaseRevision: event.patch.baseRevision,
      currentRevision: event.patch.baseRevision,
    })
  if ("threadId" in event && event.threadId !== undefined)
    return ThreadView.ResyncRequired.make({
      threadId: Thread.ThreadId.make(String(event.threadId)),
      expectedRevision: 0,
      receivedBaseRevision: 0,
      currentRevision: 0,
    })
  return undefined
}
