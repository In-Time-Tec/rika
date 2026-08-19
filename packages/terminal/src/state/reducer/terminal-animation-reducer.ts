import { Function } from "effect"
import type { ContextUsage } from "../model/terminal-context-usage"
import type { Model } from "../model/terminal-state"

const contextPercent = (usage: ContextUsage | undefined): number | undefined => {
  if (usage?._tag !== "Available") return undefined
  const usable = Math.max(0, usage.contextWindow - usage.reserveTokens)
  if (usable === 0) return usage.inputTokens > 0 ? 100 : 0
  return (usage.inputTokens / usable) * 100
}

const advanceAnimationImpl = (before: Model, after: Model, usage?: ContextUsage): Model => {
  const ticked = after.animationTick !== before.animationTick
  if (!ticked && usage === undefined) return after
  const previousUsage = contextPercent(before.contextUsage)
  const currentUsage = contextPercent(usage ?? after.contextUsage)
  const previousAnimation = after.contextAnimation
  let flashTicks = ticked ? Math.max(0, previousAnimation.flashTicks - 1) : previousAnimation.flashTicks
  let flashed75 = previousAnimation.flashed75
  let flashed90 = previousAnimation.flashed90
  if (usage !== undefined && currentUsage !== undefined) {
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
  let compactFromPercent = previousAnimation.compactFromPercent
  let compactTick = previousAnimation.compactTick
  let compactionPending = previousAnimation.compactionPending === true
  if (
    usage !== undefined &&
    (compactionPending || before.activity?._tag === "Compacting" || after.activity?._tag === "Compacting") &&
    previousUsage !== undefined &&
    currentUsage !== undefined &&
    currentUsage < previousUsage
  ) {
    compactFromPercent = previousUsage
    compactTick = 0
    compactionPending = false
  } else if (ticked && compactTick !== undefined) {
    if (compactTick >= 15) {
      compactFromPercent = undefined
      compactTick = undefined
    } else compactTick += 1
  }
  return {
    ...after,
    contextAnimation: {
      ...(compactFromPercent === undefined ? {} : { compactFromPercent }),
      ...(compactTick === undefined ? {} : { compactTick }),
      ...(compactionPending ? { compactionPending: true } : {}),
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
