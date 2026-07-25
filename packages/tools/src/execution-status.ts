import { Schema } from "effect"

export const statuses = ["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"] as const

export const Status = Schema.Literals(statuses)
export type Status = typeof Status.Type

export const terminalStatuses = ["completed", "failed", "cancelled"] as const satisfies ReadonlyArray<Status>

const terminal: ReadonlySet<string> = new Set(terminalStatuses)

export const isTerminalStatus = (status: string): boolean => terminal.has(status)

export const isActiveStatus = (status: string): boolean => !terminal.has(status) && status !== "queued"

export const occupiesQueue = (status: string): boolean => !terminal.has(status)

export const terminalEventStatus = (eventType: string): Status | undefined => {
  if (eventType === "execution.completed") return "completed"
  if (eventType === "execution.failed") return "failed"
  if (eventType === "execution.cancelled") return "cancelled"
  return undefined
}

export const isTerminalEventType = (eventType: string): boolean => terminalEventStatus(eventType) !== undefined
