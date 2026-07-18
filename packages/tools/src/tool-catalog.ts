import { Schema } from "effect"

export const Permission = Schema.Literals(["allow", "ask"])
export type Permission = typeof Permission.Type

export const Idempotency = Schema.Literals(["safe", "unsafe"])
export type Idempotency = typeof Idempotency.Type

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
  counter: Schema.optionalKey(
    Schema.Literals([
      "file",
      "media file",
      "web page",
      "thread",
      "skill",
      "guidance file",
      "search",
      "web search",
      "review",
      "GitHub check",
      "list",
    ]),
  ),
})
export type Presentation = typeof Presentation.Type

export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  permission: Permission,
  idempotency: Idempotency,
  timeoutMillis: PositiveInt,
  outputLimit: PositiveInt,
  presentation: Presentation,
})
export type Definition = typeof Definition.Type

export const definitions: ReadonlyArray<Definition> = [
  {
    name: "find_files",
    description: "List workspace files whose paths contain a query",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 20_000,
    presentation: {
      family: "explore",
      action: "search",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "search",
    },
  },
  {
    name: "grep",
    description: "Search UTF-8 workspace files for text or a regular expression",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
    presentation: {
      family: "explore",
      action: "grep",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "search",
    },
  },
  {
    name: "read_file",
    description: "Read a bounded UTF-8 file range",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
    presentation: {
      family: "explore",
      action: "read",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "file",
    },
  },
  {
    name: "create_file",
    description: "Create a new UTF-8 file without overwriting an existing path",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 10_000,
    outputLimit: 4_000,
    presentation: { family: "edit", action: "create", activeLabel: "Creating", completeLabel: "Created" },
  },
  {
    name: "edit_file",
    description: "Replace one exact anchored text occurrence and reject stale or ambiguous anchors",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 10_000,
    outputLimit: 4_000,
    presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
  },
  {
    name: "apply_patch",
    description: "Apply a validated Codex patch atomically with strict context matching",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 10_000,
    outputLimit: 4_000,
    presentation: { family: "edit", action: "patch", activeLabel: "Editing", completeLabel: "Edited" },
  },
  {
    name: "shell",
    description: "Run one command in the workspace, returning a process id when it remains running",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
    presentation: { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
  },
  {
    name: "shell_command_status",
    description: "Poll a running shell command for new bounded output and completion status",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
    presentation: { family: "direct", action: "status", activeLabel: "Waiting for", completeLabel: "Waited for" },
  },
  {
    name: "git_status",
    description: "Inspect concise Git working-tree status",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 20_000,
    presentation: {
      family: "direct",
      action: "git-status",
      activeLabel: "Inspecting",
      completeLabel: "Inspected",
    },
  },
  {
    name: "web_search",
    description: "Search the current web with Parallel and return ranked source excerpts",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 30_000,
    outputLimit: 40_000,
    presentation: {
      family: "direct",
      action: "web-search",
      activeLabel: "Web Search",
      completeLabel: "Web Search",
      counter: "web search",
    },
  },
  {
    name: "read_web_page",
    description: "Read a public HTTP(S) page as bounded readable Markdown",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 30_000,
    outputLimit: 40_000,
    presentation: {
      family: "direct",
      action: "read-web-page",
      activeLabel: "Read",
      completeLabel: "Read",
      counter: "web page",
    },
  },
  {
    name: "view_media",
    description: "Inspect a workspace image or analyze a PDF, audio, or video file",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 30_000,
    outputLimit: 40_000,
    presentation: {
      family: "explore",
      action: "media",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "media file",
    },
  },
  {
    name: "find_thread",
    description: "Find local threads using bounded product metadata queries",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 20_000,
    presentation: {
      family: "explore",
      action: "find-thread",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "thread",
    },
  },
  {
    name: "read_thread",
    description: "Read a bounded local thread transcript",
    permission: "allow",
    idempotency: "safe",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
    presentation: {
      family: "direct",
      action: "read-thread",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
    },
  },
  {
    name: "oracle",
    description: "Delegate a focused technical investigation to the read-only Oracle product agent",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
    presentation: {
      family: "agent",
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    },
  },
  {
    name: "librarian",
    description: "Delegate authoritative documentation research to the network-read-only Librarian product agent",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
    presentation: {
      family: "agent",
      action: "librarian",
      activeLabel: "Librarian researching",
      completeLabel: "Librarian researched",
    },
  },
  {
    name: "review",
    description: "Delegate a focused correctness and regression review to the read-only Review product agent",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
    presentation: {
      family: "agent",
      action: "review",
      activeLabel: "Reviewing code",
      completeLabel: "Reviewed code",
      counter: "review",
    },
  },
  {
    name: "painter",
    description: "Delegate visual work to the configured media-capable Painter product agent",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 120_000,
    outputLimit: 20_000,
    presentation: { family: "direct", action: "painter", activeLabel: "Painter", completeLabel: "Painter" },
  },
  {
    name: "task",
    description: "Start a durable Task child execution with narrowed workspace permissions",
    permission: "allow",
    idempotency: "unsafe",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
    presentation: {
      family: "agent",
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
  },
]

export const get = (name: string) => definitions.find((definition) => definition.name === name)

const agentPresentation = (action: string, activeLabel: string, completeLabel: string): Presentation => ({
  family: "agent",
  action,
  activeLabel,
  completeLabel,
})

export const resolvePresentation = (rawName: string): Presentation => {
  const name = rawName.toLowerCase()
  const defined = get(name)?.presentation
  if (defined !== undefined) return defined
  if (name === "read" || name === "view_file" || name === "get_diagnostics")
    return { family: "explore", action: "read", activeLabel: "Exploring", completeLabel: "Explored", counter: "file" }
  if (name === "grep" || name === "glob" || name === "ripgrep")
    return {
      family: "explore",
      action: name === "grep" || name === "ripgrep" ? "grep" : "search",
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
    return {
      family: "explore",
      action: "skill",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "skill",
    }
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
