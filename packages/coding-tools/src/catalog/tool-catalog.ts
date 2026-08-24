import * as RuntimeTools from "@rika/coding-tools/coding-tool-runtime"
import * as RuntimeRegistrations from "../runtime/tools"
import * as ThreadToolkits from "./thread-toolkits"
import { Effect, Function, Schema } from "effect"
import * as ToolPolicy from "../policy/coding-tools"
import { Idempotency } from "../policy/idempotency"

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
  ...Object.values(ThreadToolkits.allToolkit.tools),
]

export const handlerLayer = RuntimeTools.toolkit.toLayer(
  Effect.gen(function* () {
    const runtime = yield* RuntimeTools.Service
    return {
      grep: ({ pattern, regex, path }) => {
        let request: Extract<typeof RuntimeTools.Request.Type, { readonly _tag: "Grep" }> = {
          _tag: "Grep",
          pattern,
          regex,
        }
        if (path !== undefined) request = { ...request, path }
        return runtime.run(request)
      },
      list: ({ path, depth }) => {
        let request: Extract<typeof RuntimeTools.Request.Type, { readonly _tag: "List" }> = { _tag: "List" }
        if (path !== undefined) request = { ...request, path }
        if (depth !== undefined) request = { ...request, depth }
        return runtime.run(request)
      },
      read: ({ path, read_range }) =>
        runtime.run(read_range === undefined ? { _tag: "Read", path } : { _tag: "Read", path, readRange: read_range }),
      write: ({ path, content }) => runtime.run({ _tag: "Write", path, content }),
      edit: ({ path, old_str, new_str, replace_all }) => {
        let request: Extract<typeof RuntimeTools.Request.Type, { readonly _tag: "Edit" }> = {
          _tag: "Edit",
          path,
          oldStr: old_str,
          newStr: new_str,
        }
        if (replace_all !== undefined) request = { ...request, replaceAll: replace_all }
        return runtime.run(request)
      },
      bash: ({ command, workdir, timeout_ms }) => {
        let request: Extract<typeof RuntimeTools.Request.Type, { readonly _tag: "Bash" }> = {
          _tag: "Bash",
          command,
        }
        if (workdir !== undefined) request = { ...request, workdir }
        if (timeout_ms !== undefined) request = { ...request, timeoutMillis: timeout_ms }
        return runtime.run(request)
      },
      shell_command_status: ({ processId, waitMillis }) =>
        runtime.run(
          waitMillis == null
            ? { _tag: "ShellCommandStatus", processId }
            : { _tag: "ShellCommandStatus", processId, waitMillis },
        ),
      web_search: ({ objective, searchQueries, kind, strategy, githubSearchType }) => {
        let request: Extract<typeof RuntimeTools.Request.Type, { readonly _tag: "WebSearch" }> = {
          _tag: "WebSearch",
          objective,
          searchQueries,
        }
        if (kind !== undefined) request = { ...request, kind }
        if (strategy !== undefined) request = { ...request, strategy }
        if (githubSearchType !== undefined) request = { ...request, githubSearchType }
        return runtime.run(request)
      },
      read_web_page: ({ url, objective, fullContent, forceRefetch }) => {
        let request: Extract<typeof RuntimeTools.Request.Type, { readonly _tag: "ReadWebPage" }> = {
          _tag: "ReadWebPage",
          url,
        }
        if (objective !== undefined) request = { ...request, objective }
        if (fullContent !== undefined) request = { ...request, fullContent }
        if (forceRefetch !== undefined) request = { ...request, forceRefetch }
        return runtime.run(request)
      },
      view_media: ({ path }) => runtime.run({ _tag: "ViewMedia", path }),
    }
  }),
)

const registrations: ReadonlyArray<ToolPolicy.Registration> = [
  ...RuntimeRegistrations.registrations,
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

const agentPresentations = {
  task: agentPresentation("task", "Subagent working", "Subagent finished"),
  oracle: agentPresentation("oracle", "Oracle exploring", "Oracle has spoken"),
  librarian: agentPresentation("librarian", "Librarian researching", "Librarian researched"),
  surgeon: agentPresentation("surgeon", "Surgeon operating", "Surgeon closed up"),
  read_thread: { ...agentPresentation("read-thread", "Reading Thread", "Read Thread"), counter: "thread" },
} satisfies Readonly<Record<string, ToolPolicy.Presentation>>

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
  const defined = Object.entries(agentPresentations).find(([presentationName]) => presentationName === toolName)?.[1]
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
  if (name === "finder" || name === "search" || name.includes("codebase"))
    return agentPresentation("finder", "Searching codebase", "Searched codebase")
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
  handlerLayer,
}

export namespace Catalog {
  export type AgentPhrase = CatalogAgentPhrase
}
