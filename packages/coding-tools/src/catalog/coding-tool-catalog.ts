import * as RuntimeTools from "@rika/coding-tools/coding-tool-runtime-tools"
import * as AgentSelection from "@rika/coding-tools/agent-tool-selection"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-toolkits"
import * as AgentRegistrations from "@rika/coding-tools/agent-tool-registrations"
import * as ThreadToolkits from "@rika/coding-tools/thread-toolkits"
import { Function, Schema } from "effect"
import * as ToolPolicy from "../policy/coding-tool-policy"
import { Idempotency } from "../policy/policy-idempotency"

const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  idempotency: Idempotency,
  timeoutMillis: Schema.Int.check(Schema.isGreaterThan(0)),
  outputLimit: Schema.Int.check(Schema.isGreaterThan(0)),
  presentation: ToolPolicy.Presentation,
})
export type Definition = typeof Definition.Type

const tools: ReadonlyArray<ToolPolicy.RegisteredTool> = [
  ...Object.values(RuntimeTools.toolkit.tools),
  ...Object.values(AgentToolkits.modelToolkit.tools),
  ...Object.values(AgentToolkits.joinToolkit.tools),
  ...Object.values(ThreadToolkits.allToolkit.tools),
]

const registrations: ReadonlyArray<ToolPolicy.Registration> = [
  ...RuntimeTools.registrations,
  ...AgentRegistrations.registrations,
  ...ThreadToolkits.registrations,
]

const makeDefinitions: {
  (
    registeredTools: ReadonlyArray<ToolPolicy.RegisteredTool>,
    registered: ReadonlyArray<ToolPolicy.Registration>,
  ): ReadonlyArray<Definition>
  (
    registered: ReadonlyArray<ToolPolicy.Registration>,
  ): (registeredTools: ReadonlyArray<ToolPolicy.RegisteredTool>) => ReadonlyArray<Definition>
} = Function.dual(
  2,
  (
    registeredTools: ReadonlyArray<ToolPolicy.RegisteredTool>,
    registered: ReadonlyArray<ToolPolicy.Registration>,
  ): ReadonlyArray<Definition> => {
    const names = registeredTools.map(({ name }) => name)
    const registrationNames = registered.map(({ tool }) => tool.name)
    const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index)
    const duplicateRegistrations = registrationNames.filter((name, index) => registrationNames.indexOf(name) !== index)
    const missingDescriptions = registeredTools
      .filter(({ description }) => description === undefined)
      .map(({ name }) => name)
    const missingRegistrations = names.filter((name) => !registrationNames.includes(name))
    const missingTools = registrationNames.filter((name) => !names.includes(name))
    if (
      duplicateNames.length === 0 &&
      duplicateRegistrations.length === 0 &&
      missingDescriptions.length === 0 &&
      missingRegistrations.length === 0 &&
      missingTools.length === 0
    )
      return registeredTools.map(({ name, description }) => ({
        name,
        description: description!,
        ...registered.find((registration) => registration.tool.name === name)!.policy,
      }))
    throw new Error(
      [
        duplicateNames.length === 0 ? undefined : `duplicate tools: ${[...new Set(duplicateNames)].join(", ")}`,
        duplicateRegistrations.length === 0
          ? undefined
          : `duplicate registrations: ${[...new Set(duplicateRegistrations)].join(", ")}`,
        missingDescriptions.length === 0 ? undefined : `tools without description: ${missingDescriptions.join(", ")}`,
        missingRegistrations.length === 0
          ? undefined
          : `tools without registration: ${missingRegistrations.join(", ")}`,
        missingTools.length === 0 ? undefined : `registrations without tool: ${missingTools.join(", ")}`,
      ]
        .filter((message) => message !== undefined)
        .join("; "),
    )
  },
)

const definitions = makeDefinitions(tools, registrations)

const get = (name: string) => definitions.find((definition) => definition.name === name)

const agentPresentation = (action: string, activeLabel: string, completeLabel: string): ToolPolicy.Presentation => ({
  family: "agent",
  action,
  activeLabel,
  completeLabel,
})

const genericAgentNames = new Set(["", "child", "task", "subagent"])

const agentToolName = (profile: string): string => {
  if (genericAgentNames.has(profile)) return "task"
  return profile === "readthread" ? "read_thread" : profile
}

const agentProfile = (name: string): string =>
  name
    .trim()
    .replace(/^rika-/, "")
    .replace(/:\d+$/, "")
    .trim()

const agentDisplay = (name: string): string => {
  const profile = agentProfile(name)
  return genericAgentNames.has(profile.toLowerCase()) ? "Subagent" : profile.charAt(0).toUpperCase() + profile.slice(1)
}

const resolveAgentPresentation = (name: string): ToolPolicy.Presentation => {
  const profile = agentProfile(name).toLowerCase()
  const toolName = agentToolName(profile)
  const defined = AgentSelection.isDelegationToolName(toolName) ? get(toolName)?.presentation : undefined
  if (defined !== undefined) return defined
  const display = agentDisplay(name)
  return agentPresentation(profile, `${display} working`, `${display} finished`)
}

interface CatalogAgentPhrase {
  readonly name: string
  readonly status: "running" | "complete" | "failed" | "cancelled"
}

const agentPhrase = ({ name, status }: CatalogAgentPhrase): string => {
  const presentation = resolveAgentPresentation(name)
  if (status === "running") return presentation.activeLabel
  if (status === "complete") return presentation.completeLabel
  return `${agentDisplay(name)} ${status}`
}

const resolvePresentation = (rawName: string): ToolPolicy.Presentation => {
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
  if (name.startsWith("transfer_to_")) return resolveAgentPresentation(name.slice("transfer_to_".length))
  if (name === "spawn_child_run") return resolveAgentPresentation("task")
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

export const Catalog = {
  Definition,
  definitions,
  makeDefinitions,
  get,
  agentProfile,
  agentDisplay,
  resolveAgentPresentation,
  agentPhrase,
  resolvePresentation,
}

export namespace Catalog {
  export type AgentPhrase = CatalogAgentPhrase
}
