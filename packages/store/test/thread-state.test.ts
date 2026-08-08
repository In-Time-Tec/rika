import { describe, expect, it } from "vitest"
import { rankCase, statusRank, threadState, threadStateFromRank } from "@rika/product/thread-state"

const viaRank = (statuses: ReadonlyArray<string>) =>
  threadStateFromRank({
    rank: statuses.reduce((highest, status) => Math.max(highest, statusRank(status)), 0),
    lastStatus: statuses.at(-1),
  })

describe("thread state", () => {
  it("reports a durable execution wait as active work", () => {
    expect(threadState(["waiting"])).toBe("running")
    expect(threadState(["running", "waiting"])).toBe("running")
    expect(threadState(["waiting", "running"])).toBe("running")
  })

  it("reports an error only once nothing is active", () => {
    expect(threadState(["failed"])).toBe("error")
    expect(threadState(["failed", "queued"])).toBe("queued")
    expect(threadState(["failed", "running"])).toBe("running")
    expect(threadState(["completed"])).toBe("idle")
    expect(threadState([])).toBe("idle")
  })

  it("treats accepted as running", () => {
    expect(threadState(["accepted"])).toBe("running")
  })

  it("agrees between the in-memory rollup and the SQL rank path", () => {
    for (const statuses of [
      ["running", "waiting"],
      ["queued"],
      ["failed"],
      ["completed"],
      ["accepted", "queued"],
      ["cancelled", "failed"],
    ])
      expect(viaRank(statuses), statuses.join(",")).toBe(threadState(statuses))
  })

  it("builds the SQL ladder from the same table", () => {
    const sql = rankCase("turn.status")
    expect(sql).toContain("WHEN turn.status IN ('accepted', 'running', 'waiting', 'cancelling') THEN 2")
    expect(sql).toContain("WHEN turn.status IN ('queued') THEN 1")
    expect(sql.endsWith("ELSE 0 END")).toBe(true)
  })
})
