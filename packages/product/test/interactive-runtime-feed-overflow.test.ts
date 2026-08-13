import { describe, expect, it } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as Overflow from "../src/operation/interactive/view/feed"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const preview = (revision: number, runId = "run") => ({
  _tag: "ExecutionModelPreviewChanged" as const,
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreview" as const,
    runId,
    attemptFence: 1,
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt",
    attempt: 0,
    sequence: revision,
    changes: [{ channel: "text" as const, offset: revision, delta: String(revision) }] as const,
  },
})

describe("interactive runtime preview overflow", () => {
  it("coalesces ten thousand tentative previews to one scoped invalidation", () => {
    const state = Overflow.make()
    for (let revision = 1; revision <= 10_000; revision += 1) Overflow.remember(state, preview(revision))
    Overflow.remember(state, {
      _tag: "ExecutionControlled",
      selectionEpoch: 1,
      threadId,
      turnId,
      action: "cancelled",
    })
    expect(state.criticalOverflowed).toBe(false)
    expect(Overflow.events(state, 1, "overflow")).toEqual([
      { _tag: "ExecutionControlled", selectionEpoch: 1, threadId, turnId, action: "cancelled" },
      {
        ...preview(10_000),
        preview: { _tag: "ModelPreviewCleared", runId: "run", attemptFence: 1, generation: 0 },
      },
    ])
  })

  it("retains one invalidation for each concurrently streaming run", () => {
    const state = Overflow.make()
    Overflow.remember(state, preview(1, "child-a"))
    Overflow.remember(state, preview(1, "child-b"))

    expect(
      Overflow.events(state, 1, "overflow").map((event) =>
        event._tag === "ExecutionModelPreviewChanged" ? event.preview.runId : event._tag,
      ),
    ).toEqual(["child-a", "child-b"])
  })
})
