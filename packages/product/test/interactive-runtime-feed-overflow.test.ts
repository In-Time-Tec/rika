import { describe, expect, it } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as Overflow from "../src/operation/interactive/interactive-runtime-feed-overflow"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const preview = (revision: number) => ({
  _tag: "ExecutionModelPreviewed" as const,
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreviewed" as const,
    key: {
      runId: "run",
      attemptFence: 1,
      turn: 0,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 0,
    },
    revision,
    text: String(revision),
    reasoning: "",
    truncated: false,
  },
})

describe("interactive runtime preview overflow", () => {
  it("drops ten thousand tentative previews without consuming control recovery capacity", () => {
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
    ])
  })
})
