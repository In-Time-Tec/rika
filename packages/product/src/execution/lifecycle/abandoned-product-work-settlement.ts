export type AbandonedWorkStatus = "completed" | "failed" | "cancelled"

export const settleAbandonedStatus = (status: "running" | "queued" | AbandonedWorkStatus): AbandonedWorkStatus =>
  status === "running" || status === "queued" ? "cancelled" : status
