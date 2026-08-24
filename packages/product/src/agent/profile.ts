import { Schema } from "effect"

export const AgentProfile = Schema.Literals(["Oracle", "Librarian", "Painter", "ReadThread", "Surgeon", "Task"])
export type AgentProfile = typeof AgentProfile.Type
