import { Schema } from "effect"

export const AgentProfile = Schema.Literals([
  "Oracle",
  "Librarian",
  "Painter",
  "Review",
  "ReadThread",
  "Surgeon",
  "Task",
])
export type AgentProfile = typeof AgentProfile.Type
