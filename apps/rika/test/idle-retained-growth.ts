import { Function } from "effect"

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/**
 * Compares sustained early and late plateaus while ignoring isolated allocator peaks.
 * The sample count must contain two non-overlapping windows.
 */
export const retainedGrowthMebibytes: {
  (windowSize?: number): (samples: ReadonlyArray<number>) => number
  (samples: ReadonlyArray<number>, windowSize?: number): number
} = Function.dual(
  (args) => Array.isArray(args[0]),
  (samples: ReadonlyArray<number>, windowSize = 4): number => {
    if (!Number.isSafeInteger(windowSize) || windowSize < 1 || samples.length < windowSize * 2)
      throw new TypeError("retained growth requires two non-empty, non-overlapping windows")
    const early = median(samples.slice(0, windowSize))
    const late = median(samples.slice(-windowSize))
    return Math.max(0, late - early)
  },
)
