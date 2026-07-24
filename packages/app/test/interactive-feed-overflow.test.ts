import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as InteractiveFeedOverflow from "../src/interactive-feed-overflow"

describe("interactive feed overflow", () => {
  it("collapses repeated transcript activity into one ordered resync", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < 2; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "TranscriptPatched",
        selectionEpoch: 7,
        threadId: Thread.ThreadId.make("thread"),
        turnId: Turn.TurnId.make("turn"),
        event: {
          cursor: String(index),
          sequence: index,
          type: "model.output.delta",
          createdAt: index,
          text: "x",
        },
        revision: index,
      })

    expect(state.criticalOverflowed).toBe(false)
    expect(InteractiveFeedOverflow.events(state, 7, "bounded")).toEqual([
      {
        _tag: "TranscriptResyncRequired",
        selectionEpoch: 7,
        threadId: "thread",
        reason: "bounded",
      },
    ])
  })

  it("retains distinct outcomes in arrival order", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < 12; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        message: String(index),
      })

    expect(state.critical.map((event) => (event._tag === "ExecutionFailed" ? event.message : ""))).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    )
  })

  it("coalesces usage snapshots without overflowing the recovery window", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < InteractiveFeedOverflow.capacity + 20; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 7,
        threadId: Thread.ThreadId.make("thread"),
        cost: { _tag: "Available", usd: index },
        tokens: { _tag: "Available", total: index },
      })

    expect(state.criticalOverflowed).toBe(false)
    expect(InteractiveFeedOverflow.events(state, 7, "bounded")).toEqual([
      {
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 7,
        threadId: "thread",
        cost: { _tag: "Available", usd: InteractiveFeedOverflow.capacity + 19 },
        tokens: { _tag: "Available", total: InteractiveFeedOverflow.capacity + 19 },
      },
    ])
  })

  it("recovers an overflowed replacement as an authoritative transcript resync", () => {
    const state = InteractiveFeedOverflow.make()
    InteractiveFeedOverflow.remember(state, {
      _tag: "TranscriptReplaced",
      selectionEpoch: 7,
      threadId: Thread.ThreadId.make("thread"),
      entries: [],
      hasOlder: false,
    })

    expect(InteractiveFeedOverflow.events(state, 7, "bounded")).toEqual([
      {
        _tag: "TranscriptResyncRequired",
        selectionEpoch: 7,
        threadId: "thread",
        reason: "bounded",
      },
    ])
  })

  it("latches terminal overflow without growing past the bound", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < InteractiveFeedOverflow.capacity + 1; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "ShellCompleted",
        command: String(index),
        text: String(index),
        incognito: true,
      })

    expect(state.criticalOverflowed).toBe(true)
    expect(state.critical).toHaveLength(InteractiveFeedOverflow.capacity)
  })

  it("latches terminal overflow for too many unique recovery threads", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < InteractiveFeedOverflow.capacity + 1; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "TranscriptResyncRequired",
        selectionEpoch: 0,
        threadId: Thread.ThreadId.make(String(index)),
        reason: "bounded",
      })

    expect(state.criticalOverflowed).toBe(true)
    expect(state.transcriptThreadIds.size).toBe(InteractiveFeedOverflow.capacity)
  })
})
