import { describe, expect, it } from "vitest"
import { retainedGrowthMebibytes } from "./idle-retained-growth"

const retainedGrowthCeilingMebibytes = 150

/**
 * Growth is measured against what survives a collector sweep, so the fixtures below are shaped like
 * the series a real server produces: a cold first turn that never recurs, then a sawtooth whose
 * floor either holds steady or climbs.
 */
describe("retainedGrowthMebibytes", () => {
  it("rejects sustained retained growth at twenty-five mebibytes per turn", () => {
    const retainedLeak = Array.from({ length: 12 }, (_, index) => 100 + index * 25)
    expect(retainedGrowthMebibytes(retainedLeak)).toBe(150)
    expect(retainedGrowthMebibytes(retainedLeak)).toBeGreaterThanOrEqual(retainedGrowthCeilingMebibytes)
  })

  it("accepts a sawtooth whose floor returns to where it started", () => {
    const sawtooth = [300, 420, 540, 660, 720, 310, 430, 550, 670, 730, 320, 330]
    expect(retainedGrowthMebibytes(sawtooth)).toBe(20)
    expect(retainedGrowthMebibytes(sawtooth)).toBeLessThanOrEqual(retainedGrowthCeilingMebibytes)
  })

  it("rejects a sawtooth whose floor climbs every cycle", () => {
    const climbing = [300, 420, 540, 660, 720, 500, 620, 740, 860, 900, 700, 820]
    expect(retainedGrowthMebibytes(climbing)).toBe(320)
    expect(retainedGrowthMebibytes(climbing)).toBeGreaterThan(retainedGrowthCeilingMebibytes)
  })

  it("rejects invalid or overlapping windows", () => {
    expect(() => retainedGrowthMebibytes([1, 2, 3, 4], 3)).toThrow(TypeError)
    expect(() => retainedGrowthMebibytes([1, 2], 0)).toThrow(TypeError)
  })
})
