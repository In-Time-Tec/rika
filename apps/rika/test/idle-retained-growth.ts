import { Function } from "effect"

/**
 * Retained growth across a run of turns, measured so a garbage-collected heap cannot read as a leak.
 *
 * A physical footprint is the live set plus whatever garbage the collector has not swept yet, and
 * JSC sweeps on its own schedule. Watching a server across thirty turns shows the footprint climb
 * from 267 to 747 MiB and then fall to 331 in a single turn, while the live set sampled after a
 * forced collection holds flat near 270 MiB throughout. That rise is one sawtooth tooth, not
 * retention.
 *
 * Comparing an early window to a late window therefore reported the height of whichever tooth the
 * samples sat on, which is why a server that retains nothing failed this ceiling on roughly half its
 * runs. What survives a sweep is the floor the footprint keeps returning to, so growth is the
 * difference between the lowest level early and the lowest level late. The sample run must be long
 * enough to contain a sweep, or every sample sits on one tooth and no metric can tell them apart.
 */
export const retainedGrowthMebibytes: {
  (windowSize?: number): (samples: ReadonlyArray<number>) => number
  (samples: ReadonlyArray<number>, windowSize?: number): number
} = Function.dual(
  (args) => Array.isArray(args[0]),
  (samples: ReadonlyArray<number>, windowSize = 4): number => {
    if (!Number.isSafeInteger(windowSize) || windowSize < 1 || samples.length < windowSize * 2)
      throw new TypeError("retained growth requires two non-empty, non-overlapping windows")
    const half = Math.floor(samples.length / 2)
    return Math.max(0, Math.min(...samples.slice(half)) - Math.min(...samples.slice(0, half)))
  },
)
