import { Schema } from "effect"

export const statuses = ["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"] as const

export const Status = Schema.Literals(statuses)
export type Status = typeof Status.Type

export const terminalStatuses = ["completed", "failed", "cancelled"] as const satisfies ReadonlyArray<Status>
export type TerminalStatus = (typeof terminalStatuses)[number]

export const isTerminalStatus = (status: Status): status is TerminalStatus => {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
      return true
    case "accepted":
    case "queued":
    case "running":
    case "waiting":
      return false
  }
}

export const isActiveStatus = (status: Status): boolean => !isTerminalStatus(status) && status !== "queued"

export const occupiesQueue = (status: Status): boolean => !isTerminalStatus(status)

export const terminalEventStatus = (eventType: string): Status | undefined => {
  if (eventType === "execution.completed") return "completed"
  if (eventType === "execution.failed") return "failed"
  if (eventType === "execution.cancelled") return "cancelled"
  return undefined
}

export const isTerminalEventType = (eventType: string): boolean => terminalEventStatus(eventType) !== undefined
