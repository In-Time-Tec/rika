import { describe, expect, it } from "vitest"
import * as ContextUsage from "../src/context-usage"

const thresholds = {
  contextWindow: 100,
  reserveTokens: 20,
  keepRecentTokens: 30,
  toolOutputMaxBytes: 1_024,
}

describe("ContextUsage", () => {
  it("projects threshold and checkpoint data for product views", () => {
    expect(ContextUsage.analyze(80, thresholds).shouldCompact).toBe(false)
    expect(ContextUsage.analyze(81, thresholds, { cursor: "7", digest: "abc" })).toEqual({
      contextTokens: 81,
      contextWindow: 100,
      reserveTokens: 20,
      availableTokens: 80,
      utilization: 0.81,
      shouldCompact: true,
      checkpointCursor: "7",
      checkpointDigest: "abc",
    })
    expect(ContextUsage.format(ContextUsage.analyze(81, thresholds, { cursor: "7", digest: "abc" }))).toBe(
      "81/100 tokens (81%), 80 available, compaction required, checkpoint 7",
    )
  })

  it("handles exhausted and zero-sized context windows", () => {
    const exhausted = ContextUsage.analyze(0, { ...thresholds, contextWindow: 10, reserveTokens: 20 })
    expect(exhausted.availableTokens).toBe(0)
    expect(ContextUsage.format(exhausted)).toBe("0/10 tokens (0%), 0 available")

    const zero = ContextUsage.analyze(1, { ...thresholds, contextWindow: 0 })
    expect(zero.utilization).toBe(1)
    expect(ContextUsage.format(zero)).toBe("1/0 tokens (100%), 0 available, compaction required")
  })
})
