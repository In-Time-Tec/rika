import { Schema } from "effect"
import * as AgentTools from "./agent-tools"
import * as ThreadTools from "./thread-tools"
import * as Runtime from "./tool-runtime"
import * as ToolPolicy from "./tool-policy"

export { Idempotency, Permission, Presentation } from "./tool-policy"

export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  permission: ToolPolicy.Permission,
  idempotency: ToolPolicy.Idempotency,
  timeoutMillis: Schema.Int.check(Schema.isGreaterThan(0)),
  outputLimit: Schema.Int.check(Schema.isGreaterThan(0)),
  presentation: ToolPolicy.Presentation,
})
export type Definition = typeof Definition.Type

const tools: ReadonlyArray<{ readonly name: string; readonly description?: string | undefined }> = [
  ...Object.values(Runtime.toolkit.tools),
  ...Object.values(AgentTools.modelToolkit.tools),
  ...Object.values(ThreadTools.toolkit.tools),
]
export const makeDefinitions = (
  registeredTools: ReadonlyArray<{ readonly name: string; readonly description?: string | undefined }>,
  policies: Readonly<Record<string, ToolPolicy.Policy>>,
): ReadonlyArray<Definition> => {
  const names = registeredTools.map(({ name }) => name)
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index)
  const missingDescriptions = registeredTools
    .filter(({ description }) => description === undefined)
    .map(({ name }) => name)
  const missingPolicies = names.filter((name) => policies[name] === undefined)
  const missingTools = Object.keys(policies).filter((name) => !names.includes(name))
  if (
    duplicateNames.length === 0 &&
    missingDescriptions.length === 0 &&
    missingPolicies.length === 0 &&
    missingTools.length === 0
  )
    return registeredTools.map(({ name, description }) => ({ name, description: description!, ...policies[name]! }))
  throw new Error(
    [
      duplicateNames.length === 0 ? undefined : `duplicate tools: ${[...new Set(duplicateNames)].join(", ")}`,
      missingDescriptions.length === 0 ? undefined : `tools without description: ${missingDescriptions.join(", ")}`,
      missingPolicies.length === 0 ? undefined : `tools without policy: ${missingPolicies.join(", ")}`,
      missingTools.length === 0 ? undefined : `policies without tool: ${missingTools.join(", ")}`,
    ]
      .filter((message) => message !== undefined)
      .join("; "),
  )
}

export const definitions = makeDefinitions(tools, ToolPolicy.policies)

export const get = (name: string) => definitions.find((definition) => definition.name === name)

const agentPresentation = (action: string, activeLabel: string, completeLabel: string): ToolPolicy.Presentation => ({
  family: "agent",
  action,
  activeLabel,
  completeLabel,
})

export const resolvePresentation = (rawName: string): ToolPolicy.Presentation => {
  const name = rawName.toLowerCase()
  const defined = get(name)?.presentation
  if (defined !== undefined) return defined
  if (name === "read" || name === "view_file" || name === "get_diagnostics")
    return { family: "explore", action: "read", activeLabel: "Exploring", completeLabel: "Explored", counter: "file" }
  if (name === "grep" || name === "glob" || name === "ripgrep")
    return {
      family: "explore",
      action: name === "glob" ? "search" : "grep",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "search",
    }
  if (name === "bash" || name === "shell_command" || name === "run_terminal_command")
    return { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" }
  if (name === "write_file")
    return { family: "edit", action: "create", activeLabel: "Creating", completeLabel: "Created" }
  if (name === "painter")
    return { family: "direct", action: "painter", activeLabel: "Painter", completeLabel: "Painter" }
  if (name === "finder" || name === "search" || name.includes("codebase"))
    return agentPresentation("finder", "Searching codebase", "Searched codebase")
  if (name === "review" || name.includes("review"))
    return agentPresentation("review", "Reviewing code", "Reviewed code")
  if (name.startsWith("transfer_to_")) {
    const profile = name.slice("transfer_to_".length)
    if (profile === "oracle") return agentPresentation("oracle", "Oracle exploring", "Oracle has spoken")
    if (profile === "librarian") return agentPresentation("librarian", "Librarian researching", "Librarian researched")
    if (profile.length === 0 || profile === "task" || profile === "child" || profile === "subagent")
      return agentPresentation("task", "Subagent working", "Subagent finished")
    const display = profile.charAt(0).toUpperCase() + profile.slice(1)
    return agentPresentation(profile, `${display} working`, `${display} finished`)
  }
  if (name === "spawn_child_run") return agentPresentation("task", "Subagent working", "Subagent finished")
  if (name === "skill")
    return { family: "explore", action: "skill", activeLabel: "Exploring", completeLabel: "Explored", counter: "skill" }
  if (name === "list_agent_modes")
    return {
      family: "direct",
      action: "agent-modes",
      activeLabel: "Checking available agent modes",
      completeLabel: "Checked available agent modes",
    }
  if (name === "load_plugin")
    return { family: "direct", action: "load-plugin", activeLabel: "Loading plugin", completeLabel: "Loaded plugin" }
  if (name === "archive_current_thread")
    return {
      family: "direct",
      action: "archive-thread",
      activeLabel: "Archiving this thread",
      completeLabel: "Archived this thread",
    }
  if (name === "create_thread")
    return {
      family: "direct",
      action: "create-thread",
      activeLabel: "Creating thread",
      completeLabel: "Created thread",
    }
  if (name === "send_message_to_thread")
    return {
      family: "direct",
      action: "message-thread",
      activeLabel: "Sending message to thread",
      completeLabel: "Sent message to thread",
    }
  if (name === "send_message_to_puck")
    return {
      family: "direct",
      action: "message-puck",
      activeLabel: "Sending message to Puck",
      completeLabel: "Sent message to Puck",
    }
  if (name === "slack_read" || name === "slack_write")
    return { family: "direct", action: name, activeLabel: "Slack", completeLabel: "Slack" }
  return { family: "generic", action: "tool", activeLabel: "Running tool", completeLabel: "Ran tool" }
}
