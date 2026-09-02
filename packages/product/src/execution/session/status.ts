import { Schema } from "effect"

export const statuses = [
  "accepted",
  "queued",
  "running",
  "waiting",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const

export const Status = Schema.Literals(statuses)
export type Status = typeof Status.Type

export type ActivationStatus = Exclude<Status, "accepted" | "queued">

export const terminalStatuses = ["completed", "failed", "cancelled"] as const satisfies ReadonlyArray<Status>
type TerminalStatus = (typeof terminalStatuses)[number]

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
    case "cancelling":
      return false
  }
}

export const isActiveStatus = (status: Status): boolean => !isTerminalStatus(status) && status !== "queued"

export const occupiesQueue = (status: Status): boolean => !isTerminalStatus(status)
