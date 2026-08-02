import { Function } from "effect"
import type { ContextUsage } from "../model/terminal-context-usage"
import type { Model } from "../model/terminal-state"
import type { TranscriptBlock } from "../model/terminal-transcript-state"

const contextPercent = (usage: ContextUsage | undefined): number | undefined => {
  if (usage?._tag !== "Available") return undefined
  const usable = Math.max(0, usage.contextWindow - usage.reserveTokens)
  if (usable === 0) return usage.inputTokens > 0 ? 100 : 0
  return (usage.inputTokens / usable) * 100
}
const hasRunningCompaction = (model: Model): boolean =>
  model.blocks.some((block) => {
    const candidate = block as TranscriptBlock
    return candidate._tag === "Compaction" && candidate.status === "running"
  })

const advanceAnimationImpl = (before: Model, after: Model, usage?: ContextUsage): Model => {
  const previousUsage = contextPercent(before.contextUsage)
  const currentUsage = contextPercent(usage ?? after.contextUsage)
  const previousAnimation = before.contextAnimation
  let flashTicks = Math.max(0, previousAnimation.flashTicks - 1)
  let flashed75 = previousAnimation.flashed75
  let flashed90 = previousAnimation.flashed90
  if (currentUsage === undefined) {
    flashed75 = false
    flashed90 = false
  } else {
    if (currentUsage < 75) flashed75 = false
    else if (!flashed75 && (previousUsage === undefined || previousUsage < 75)) {
      flashed75 = true
      flashTicks = Math.max(flashTicks, 2)
    }
    if (currentUsage < 90) flashed90 = false
    else if (!flashed90 && (previousUsage === undefined || previousUsage < 90)) {
      flashed90 = true
      flashTicks = Math.max(flashTicks, 2)
    }
  }
  const nextTick = before.animationTick + 1
  const runningCompaction = hasRunningCompaction(after)
  const settlingCompaction =
    !runningCompaction &&
    previousAnimation.compactFromPercent !== undefined &&
    previousAnimation.compactTick === before.animationTick
  if (usage === undefined && !runningCompaction && !settlingCompaction && previousAnimation.flashTicks === 0)
    return after
  let compactFromPercent: number | undefined
  if (runningCompaction) compactFromPercent = previousAnimation.compactFromPercent ?? previousUsage ?? currentUsage
  else if (settlingCompaction) compactFromPercent = previousAnimation.compactFromPercent
  return {
    ...after,
    animationTick: nextTick,
    contextAnimation: {
      ...(compactFromPercent === undefined ? {} : { compactFromPercent }),
      ...(runningCompaction || settlingCompaction ? { compactTick: nextTick } : {}),
      flashTicks,
      flashed75,
      flashed90,
    },
  }
}

export const advanceAnimation: {
  (before: Model, after: Model, usage?: ContextUsage): Model
  (after: Model, usage?: ContextUsage): (before: Model) => Model
} = Function.dual(3, advanceAnimationImpl)
