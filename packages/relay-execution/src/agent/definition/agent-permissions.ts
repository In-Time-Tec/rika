import { names } from "./agent-names"
import { profilePermissions } from "./baton-agent-definition"

export const parentPermissions = [...new Set(names.flatMap((name) => profilePermissions[name]))].map((name) => ({
  name,
  value: true,
}))

export const rootPermissions = [
  ...parentPermissions,
  { name: "thread.coordinate", value: true },
  { name: "thread.control", value: true },
]

export const childRunSpawnPermission = { name: "relay.child_run.spawn", value: true }

export const subagentHandoffTargets = [
  { name: "oracle", preset_name: "Oracle" },
  { name: "librarian", preset_name: "Librarian" },
  { name: "review", preset_name: "Review" },
  { name: "read_thread", preset_name: "ReadThread" },
  { name: "surgeon", preset_name: "Surgeon" },
  { name: "task", preset_name: "Task" },
] as const
