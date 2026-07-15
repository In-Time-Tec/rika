import { Schema } from "effect"

export const Permission = Schema.Literals(["allow", "ask"])
export type Permission = typeof Permission.Type

export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  permission: Permission,
  timeoutMillis: Schema.Finite,
  outputLimit: Schema.Finite,
})
export type Definition = typeof Definition.Type

export const definitions: ReadonlyArray<Definition> = [
  {
    name: "find_files",
    description: "List workspace files whose paths contain a query",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 20_000,
  },
  {
    name: "grep",
    description: "Search UTF-8 workspace files for text or a regular expression",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
  },
  {
    name: "read_file",
    description: "Read a bounded UTF-8 file range",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
  },
  {
    name: "create_file",
    description: "Create a new UTF-8 file without overwriting an existing path",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 4_000,
  },
  {
    name: "edit_file",
    description: "Replace one exact anchored text occurrence and reject stale or ambiguous anchors",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 4_000,
  },
  {
    name: "apply_patch",
    description: "Apply a validated Codex patch atomically with strict context matching",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 4_000,
  },
  {
    name: "shell",
    description: "Run one command in the workspace, returning a process id when it remains running",
    permission: "allow",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
  },
  {
    name: "shell_command_status",
    description: "Poll a running shell command for new bounded output and completion status",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
  },
  {
    name: "git_status",
    description: "Inspect concise Git working-tree status",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 20_000,
  },
  {
    name: "web_search",
    description: "Search the current web with Parallel and return ranked source excerpts",
    permission: "allow",
    timeoutMillis: 30_000,
    outputLimit: 40_000,
  },
  {
    name: "read_web_page",
    description: "Read a public HTTP(S) page as bounded readable Markdown",
    permission: "allow",
    timeoutMillis: 30_000,
    outputLimit: 40_000,
  },
  {
    name: "view_media",
    description: "Inspect a workspace image or analyze a PDF, audio, or video file",
    permission: "allow",
    timeoutMillis: 30_000,
    outputLimit: 40_000,
  },
  {
    name: "find_thread",
    description: "Find local threads using bounded product metadata queries",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 20_000,
  },
  {
    name: "read_thread",
    description: "Read a bounded local thread transcript",
    permission: "allow",
    timeoutMillis: 10_000,
    outputLimit: 40_000,
  },
  {
    name: "oracle",
    description: "Delegate a focused technical investigation to the read-only Oracle product agent",
    permission: "allow",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
  },
  {
    name: "librarian",
    description: "Delegate authoritative documentation research to the network-read-only Librarian product agent",
    permission: "allow",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
  },
  {
    name: "painter",
    description: "Delegate visual work to the configured media-capable Painter product agent",
    permission: "allow",
    timeoutMillis: 120_000,
    outputLimit: 20_000,
  },
  {
    name: "task",
    description: "Start a durable Task child execution with narrowed workspace permissions",
    permission: "allow",
    timeoutMillis: 120_000,
    outputLimit: 40_000,
  },
]

export const get = (name: string) => definitions.find((definition) => definition.name === name)
