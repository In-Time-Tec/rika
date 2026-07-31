export const names = ["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Surgeon", "Task"] as const
export type Name = (typeof names)[number]
export type AgentKey = "librarian" | "painter" | "review" | "readThread" | "surgeon" | "task"
export const agentKeyForName = (name: Name): AgentKey | undefined =>
  name === "Oracle" ? undefined : ((name.charAt(0).toLowerCase() + name.slice(1)) as AgentKey)
