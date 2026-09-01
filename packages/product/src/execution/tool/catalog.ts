import { Function, Schema } from "effect"
import * as Runtime from "./runtime"
import * as ToolPolicy from "./policy"

export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  idempotency: ToolPolicy.Idempotency,
  timeoutMillis: Schema.Int.check(Schema.isGreaterThan(0)),
  outputLimit: Schema.Int.check(Schema.isGreaterThan(0)),
  presentation: ToolPolicy.Presentation,
})
export type Definition = typeof Definition.Type

export const makeDefinitions: {
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

export const definitions = makeDefinitions(Object.values(Runtime.toolkit.tools), Runtime.registrations)
export const get = (name: string) => definitions.find((definition) => definition.name === name)

interface PresentationFallback {
  readonly matches: (name: string) => boolean
  readonly presentation: (name: string) => ToolPolicy.Presentation
}

const named =
  (...names: ReadonlyArray<string>) =>
  (name: string) =>
    names.includes(name)
const fixed = (presentation: ToolPolicy.Presentation) => () => presentation
const agentPresentation = (action: string, activeLabel: string, completeLabel: string): ToolPolicy.Presentation => ({
  family: "agent",
  action,
  activeLabel,
  completeLabel,
})

const presentationFallbacks: ReadonlyArray<PresentationFallback> = [
  {
    matches: named("read", "view_file", "get_diagnostics"),
    presentation: fixed({
      family: "explore",
      action: "read",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "file",
    }),
  },
  {
    matches: named("grep", "glob", "ripgrep"),
    presentation: (name) => ({
      family: "explore",
      action: name === "glob" ? "search" : "grep",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "search",
    }),
  },
  {
    matches: named("bash", "shell_command", "run_terminal_command"),
    presentation: fixed({ family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" }),
  },
  {
    matches: named("write_file"),
    presentation: fixed({ family: "edit", action: "create", activeLabel: "Creating", completeLabel: "Created" }),
  },
  {
    matches: (name) => name === "finder" || name === "search" || name.includes("codebase"),
    presentation: fixed(agentPresentation("finder", "Searching codebase", "Searched codebase")),
  },
  {
    matches: named("skill"),
    presentation: fixed({
      family: "explore",
      action: "skill",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "skill",
    }),
  },
  {
    matches: named("list_agent_modes"),
    presentation: fixed({
      family: "direct",
      action: "agent-modes",
      activeLabel: "Checking available agent modes",
      completeLabel: "Checked available agent modes",
    }),
  },
  {
    matches: named("load_plugin"),
    presentation: fixed({
      family: "direct",
      action: "load-plugin",
      activeLabel: "Loading plugin",
      completeLabel: "Loaded plugin",
    }),
  },
  {
    matches: named("archive_current_thread"),
    presentation: fixed({
      family: "direct",
      action: "archive-thread",
      activeLabel: "Archiving this thread",
      completeLabel: "Archived this thread",
    }),
  },
  {
    matches: named("send_message_to_thread"),
    presentation: fixed({
      family: "direct",
      action: "message-thread",
      activeLabel: "Sending message to thread",
      completeLabel: "Sent message to thread",
    }),
  },
  {
    matches: named("send_message_to_puck"),
    presentation: fixed({
      family: "direct",
      action: "message-puck",
      activeLabel: "Sending message to Puck",
      completeLabel: "Sent message to Puck",
    }),
  },
  {
    matches: named("slack_read", "slack_write"),
    presentation: (name) => ({ family: "direct", action: name, activeLabel: "Slack", completeLabel: "Slack" }),
  },
]

export const resolvePresentation = (rawName: string): ToolPolicy.Presentation => {
  const name = rawName.toLowerCase()
  const defined = get(name)?.presentation
  if (defined !== undefined) return defined
  const fallback = presentationFallbacks.find((candidate) => candidate.matches(name))
  if (fallback !== undefined) return fallback.presentation(name)
  return { family: "generic", action: "tool", activeLabel: "Running tool", completeLabel: "Ran tool" }
}

export const Catalog = { Definition, definitions, makeDefinitions, get, resolvePresentation }
