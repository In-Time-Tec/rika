import { describe, expect, it } from "vitest"
import { ThreadId } from "@rika/product/thread-record"
import { lastContinuable, ThreadSummary } from "@rika/product/thread-summary"

const summary = (id: string, turnCount: number, lastActivityAt: number) =>
  ThreadSummary.make({
    id: ThreadId.make(id),
    workspace: "/work",
    title: "New thread",
    pinned: false,
    archived: false,
    status: "idle",
    unread: false,
    lastActivityAt,
    turnCount,
  })

describe("lastContinuable", () => {
  it("skips a newer Thread that was created but never prompted", () => {
    const empty = summary("created-after-quit", 0, 30)
    const worked = summary("worked-in", 2, 20)
    expect(lastContinuable([empty, worked, summary("older", 1, 10)])).toBe(worked)
  })

  it("falls back to the newest Thread when none has a Turn", () => {
    const newest = summary("newest", 0, 30)
    expect(lastContinuable([newest, summary("older", 0, 10)])).toBe(newest)
  })

  it("has nothing to continue without Threads", () => {
    expect(lastContinuable([])).toBeUndefined()
  })
})
