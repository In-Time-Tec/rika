import { Function } from "effect"
import type { ContextUsage } from "../context/usage"
import type { Model } from "../model"

const contextPercent = (usage: ContextUsage | undefined): number | undefined => {
  if (usage?._tag !== "Available") return undefined
  const usable = Math.max(0, usage.contextWindow - usage.reserveTokens)
  if (usable === 0) return usage.inputTokens > 0 ? 100 : 0
  return (usage.inputTokens / usable) * 100
}

interface FlashState {
  readonly flashTicks: number
  readonly flashed75: boolean
  readonly flashed90: boolean
}

interface CompactionState {
  readonly compactFromPercent: number | undefined
  readonly compactTick: number | undefined
  readonly compactionPending: boolean
}

const advanceCompaction = (
  before: Model,
  after: Model,
  previousUsage: number | undefined,
  currentUsage: number | undefined,
  usageChanged: boolean,
  ticked: boolean,
): CompactionState => {
  const pending = after.contextAnimation.compactionPending === true
  const compacting = pending || before.activity?._tag === "Compacting" || after.activity?._tag === "Compacting"
  if (
    usageChanged &&
    compacting &&
    previousUsage !== undefined &&
    currentUsage !== undefined &&
    currentUsage < previousUsage
  )
    return { compactFromPercent: previousUsage, compactTick: 0, compactionPending: false }
  const tick = after.contextAnimation.compactTick
  if (!ticked || tick === undefined) {
    return {
      compactFromPercent: after.contextAnimation.compactFromPercent,
      compactTick: tick,
      compactionPending: pending,
    }
  }
  if (tick >= 15) return { compactFromPercent: undefined, compactTick: undefined, compactionPending: pending }
  return {
    compactFromPercent: after.contextAnimation.compactFromPercent,
    compactTick: tick + 1,
    compactionPending: pending,
  }
}

const advanceFlash = (
  previous: Model["contextAnimation"],
  previousUsage: number | undefined,
  currentUsage: number | undefined,
  ticked: boolean,
  usageChanged: boolean,
): FlashState => {
  let flashTicks = ticked ? Math.max(0, previous.flashTicks - 1) : previous.flashTicks
  let flashed75 = previous.flashed75
  let flashed90 = previous.flashed90
  if (!usageChanged || currentUsage === undefined) return { flashTicks, flashed75, flashed90 }
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
  return { flashTicks, flashed75, flashed90 }
}

const advanceAnimationImpl = (before: Model, after: Model, usage?: ContextUsage): Model => {
  const ticked = after.animationTick !== before.animationTick
  if (!ticked && usage === undefined) return after
  const previousUsage = contextPercent(before.contextUsage)
  const currentUsage = contextPercent(usage ?? after.contextUsage)
  const previousAnimation = after.contextAnimation
  const munchTick = ticked && after.busy ? previousAnimation.munchTick + 1 : previousAnimation.munchTick
  const flash = advanceFlash(previousAnimation, previousUsage, currentUsage, ticked, usage !== undefined)
  const { compactFromPercent, compactTick, compactionPending } = advanceCompaction(
    before,
    after,
    previousUsage,
    currentUsage,
    usage !== undefined,
    ticked,
  )
  const baseAnimation = {
    munchTick,
    ...flash,
  }
  const compactedAnimation = compactFromPercent === undefined ? baseAnimation : { ...baseAnimation, compactFromPercent }
  const tickingAnimation = compactTick === undefined ? compactedAnimation : { ...compactedAnimation, compactTick }
  const contextAnimation = compactionPending ? { ...tickingAnimation, compactionPending: true } : tickingAnimation
  return {
    ...after,
    contextAnimation,
  }
}

export const advanceAnimation: {
  (before: Model, after: Model, usage?: ContextUsage): Model
  (after: Model, usage?: ContextUsage): (before: Model) => Model
} = Function.dual(3, advanceAnimationImpl)
