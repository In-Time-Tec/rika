import { describe, expect, it } from "vitest"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import { eventForSequenceGap } from "../src/transport/client/server-client-feed-gap"

const threadId = Thread.ThreadId.make("thread-1")

describe("interactive feed sequence gaps", () => {
  it("preserves an explicit resync event", () => {
    const event = ThreadView.ResyncRequired.make({
      threadId,
      expectedRevision: 3,
      receivedBaseRevision: 5,
      currentRevision: 7,
    })
    expect(eventForSequenceGap(event)).toBe(event)
  })

  it("derives the resync revision from a snapshot", () => {
    const event = {
      _tag: "ThreadViewSnapshot",
      snapshot: { thread: { id: threadId }, revision: 7 },
    } as unknown as InteractiveEvent.InteractiveEvent
    expect(eventForSequenceGap(event)).toEqual(
      ThreadView.ResyncRequired.make({
        threadId,
        expectedRevision: 7,
        receivedBaseRevision: 7,
        currentRevision: 7,
      }),
    )
  })

  it("derives the resync revisions from a patch", () => {
    const event = {
      _tag: "ThreadViewPatch",
      patch: { threadId, revision: 8, baseRevision: 6 },
    } as unknown as InteractiveEvent.InteractiveEvent
    expect(eventForSequenceGap(event)).toEqual(
      ThreadView.ResyncRequired.make({
        threadId,
        expectedRevision: 8,
        receivedBaseRevision: 6,
        currentRevision: 6,
      }),
    )
  })

  it("uses a conservative revision for other thread events", () => {
    const event = { _tag: "ThreadActivated", threadId, title: "One" } as InteractiveEvent.InteractiveEvent
    expect(eventForSequenceGap(event)).toEqual(
      ThreadView.ResyncRequired.make({
        threadId,
        expectedRevision: 0,
        receivedBaseRevision: 0,
        currentRevision: 0,
      }),
    )
  })

  it("cannot recover a sequence gap from an event without a thread", () => {
    expect(eventForSequenceGap({ _tag: "AssistantCompleted", text: "done" })).toBeUndefined()
  })
})
