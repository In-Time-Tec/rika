import { Schema } from "effect"

/**
 * The terminal's own view of a goal. The durable record lives in `@rika/product`; the application
 * boundary projects it into this presentation shape, so the TUI never depends on product state.
 */
export const GoalIndicator = Schema.Struct({
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "complete", "errored"]),
  startedAtMillis: Schema.Finite,
})
export type GoalIndicator = typeof GoalIndicator.Type

/** Elapsed is always derived from the goal's start and the current time, never accumulated. */
export const formatGoalElapsed = (millis: number): string => {
  const seconds = Math.max(0, Math.floor(millis / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days === 1 ? "1 day" : `${days} days`
}
