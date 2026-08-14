import { describe, expect, it } from "vitest"
import { retainedGrowthMebibytes } from "./idle-retained-growth"

const retainedGrowthCeilingMebibytes = 150

describe("retainedGrowthMebibytes", () => {
  it("rejects sustained retained growth at twenty-five mebibytes per turn", () => {
    const retainedLeak = Array.from({ length: 12 }, (_, index) => 100 + index * 25)
    expect(retainedGrowthMebibytes(retainedLeak)).toBe(200)
    expect(retainedGrowthMebibytes(retainedLeak)).toBeGreaterThan(retainedGrowthCeilingMebibytes)
  })

  it("accepts an allocator cliff followed by release", () => {
    const allocatorCliff = [100, 200, 350, 500, 620, 650, 400, 430, 450, 420, 410, 400]
    expect(retainedGrowthMebibytes(allocatorCliff)).toBe(140)
    expect(retainedGrowthMebibytes(allocatorCliff)).toBeLessThanOrEqual(retainedGrowthCeilingMebibytes)
  })

  it("rejects invalid or overlapping windows", () => {
    expect(() => retainedGrowthMebibytes([1, 2, 3, 4], 3)).toThrow(TypeError)
    expect(() => retainedGrowthMebibytes([1, 2], 0)).toThrow(TypeError)
  })
})
