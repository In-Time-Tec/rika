import { Duration, Function } from "effect"
import type { UsageTime } from "./terminal-usage-state"

export const activeTimeIcon = "◷"
export const activeTimeAt: {
  (time: Extract<UsageTime, { readonly _tag: "Available" }>, now: number): Duration.Duration
  (now: number): (time: Extract<UsageTime, { readonly _tag: "Available" }>) => Duration.Duration
} = Function.dual(
  2,
  (time: Extract<UsageTime, { readonly _tag: "Available" }>, now: number): Duration.Duration =>
    Duration.sum(
      Duration.millis(time.accumulatedMillis),
      Duration.millis(time.activeSince === undefined ? 0 : Math.max(0, now - time.activeSince)),
    ),
)

export const formatActiveTime = (duration: Duration.Duration): string => {
  const parts = Duration.parts(duration)
  if (parts.days > 0) return `${activeTimeIcon} ${parts.days}d${parts.hours > 0 ? ` ${parts.hours}h` : ""}`
  if (parts.hours > 0) return `${activeTimeIcon} ${parts.hours}h${parts.minutes > 0 ? ` ${parts.minutes}m` : ""}`
  if (parts.minutes > 0) return `${activeTimeIcon} ${parts.minutes}m${parts.seconds > 0 ? ` ${parts.seconds}s` : ""}`
  return `${activeTimeIcon} ${parts.seconds}s`
}
