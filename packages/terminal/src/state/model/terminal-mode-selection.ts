import { modeIds } from "@rika/config/behavior-mode"
import type { Mode } from "./terminal-state"

export const nextMode = (mode: Mode): Mode => modeIds[(modeIds.indexOf(mode) + 1) % modeIds.length]!
export const nextUsageDisplay = (display: "cost" | "tokens" | "time" | undefined): "cost" | "tokens" | "time" => {
  if (display === undefined || display === "cost") return "tokens"
  if (display === "tokens") return "time"
  return "cost"
}
