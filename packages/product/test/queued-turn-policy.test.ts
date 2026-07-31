import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurns, staleQueuedTurnsError } from "../src/thread/queue/pending-turn-policy"

const queued = (id: string, createdAt: number): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(id),
  threadId: Thread.ThreadId.make("thread"),
  prompt: id,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: Turn.testExecutionRoute(),
  status: "queued",
  stopIntent: "none",
  createdAt,
  updatedAt: createdAt,
})

describe("queued turn promotion policy", () => {
  it("treats turns within the age window as fresh", () => {
    const now = 1_000_000
    expect(staleQueuedTurns([queued("fresh", now - 1_000)], now, queuedTurnPromoteMaxAgeMs)).toEqual([])
  })

  it("flags turns older than the promotion window", () => {
    const now = queuedTurnPromoteMaxAgeMs + 10
    const stale = staleQueuedTurns([queued("old", 0)], now, queuedTurnPromoteMaxAgeMs)
    expect(stale.map((turn) => String(turn.id))).toEqual(["old"])
  })

  it("returns a typed refusal for stale queued work", () => {
    const error = staleQueuedTurnsError(
      Thread.ThreadId.make("thread"),
      [queued("old", 0)],
      queuedTurnPromoteMaxAgeMs + 1,
      queuedTurnPromoteMaxAgeMs,
    )
    expect(error?._tag).toBe("StaleQueuedTurns")
    expect(error?.turnIds.map(String)).toEqual(["old"])
    expect(error?.message).toContain("Refusing to auto-run")
  })
})
