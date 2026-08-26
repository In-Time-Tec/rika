import { Duration } from "effect"

export const relativeTime = (elapsedMillis: number): string => {
  const parts = Duration.parts(Duration.millis(Math.max(0, elapsedMillis)))
  if (parts.days > 0) return `${parts.days}d ago`
  if (parts.hours > 0) return `${parts.hours}h ago`
  return parts.minutes > 0 ? `${parts.minutes}m ago` : "now"
}
