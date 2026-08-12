import { describe, expect, it } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as Overflow from "../src/transport/host/server-host-feed-overflow"

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

describe("server host preview overflow", () => {
  it("drops preview storms while retaining control outcomes", () => {
    const state = Overflow.make()
    for (let revision = 1; revision <= 10_000; revision += 1) Overflow.remember(state, preview(revision))
    const controlled = { _tag: "ExecutionControlled" as const, threadId, turnId, action: "cancelled" as const }
    Overflow.remember(state, controlled)
    expect(state.degraded).toBeUndefined()
    expect(Overflow.events(state)).toEqual([controlled])
  })
})

it("preserves the thread resync when a control event follows a lost patch", () => {
  const state = Overflow.make()
  // Fill the view capacity with distinct threads so the next view event degrades the state.
  for (let index = 0; index < 64; index += 1)
    Overflow.remember(state, {
      _tag: "ThreadViewPatch",
      patch: {
        threadId: Thread.ThreadId.make(`t${index}`),
        baseRevision: 0,
        revision: 1,
        upsert: [],
        remove: [],
        turnChanges: [],
      },
    })
  Overflow.remember(state, {
    _tag: "ThreadViewPatch",
    patch: {
      threadId: Thread.ThreadId.make("overflowed"),
      baseRevision: 0,
      revision: 1,
      upsert: [],
      remove: [],
      turnChanges: [],
    },
  })
  expect(state.degraded).toBeDefined()
  // A control event arriving after the lost patch must not replace the recovery resync.
  Overflow.remember(state, { _tag: "ExecutionControlled", threadId, turnId, action: "cancelled" })
  const recovered = Overflow.events(state)
  expect(recovered).toHaveLength(1)
  expect(recovered[0]?._tag).toBe("ResyncRequired")
})
