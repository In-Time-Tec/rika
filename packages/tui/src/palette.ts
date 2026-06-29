export interface Command {
  readonly id: string
  readonly category: string
  readonly action: string
  readonly hint: string
  readonly command: string
  readonly key?: string
}

export const commands: ReadonlyArray<Command> = [
  { id: "thread-switch", category: "thread", action: "switch", hint: "switch threads", command: "/threads" },
  { id: "amp-relaunch", category: "amp", action: "relaunch (quit & reopen)", hint: "restart the interactive session", command: "/relaunch" },
  { id: "amp-help", category: "amp", action: "help", hint: "show help", command: "/help" },
  { id: "amp-welcome", category: "amp", action: "show welcome", hint: "show the welcome surface", command: "/welcome" },
  { id: "amp-credits", category: "amp", action: "end credits", hint: "show credits", command: "/credits" },
  { id: "amp-version", category: "amp", action: "show version", hint: "show version", command: "/version" },
  { id: "amp-quit", category: "amp", action: "quit", hint: "leave Rika", command: "/exit", key: "Ctrl+C Ctrl+C" },
  { id: "ast-grep-outline-status", category: "ast-grep", action: "ast-grep outline status", hint: "show ast-grep outline status", command: "/ast-grep outline status" },
  { id: "debug-page-logs", category: "debug", action: "page logs", hint: "show debug page logs", command: "/debug page logs" },
  { id: "debug-copy-command", category: "debug", action: "copy command", hint: "copy the current debug command", command: "/debug copy command" },
  { id: "ide-connect", category: "ide", action: "connect", hint: "connect an IDE", command: "/ide connect" },
  { id: "mcp-authenticate", category: "mcp", action: "authenticate", hint: "authenticate MCP servers", command: "/mcp authenticate" },
  { id: "mcp-info", category: "mcp", action: "info", hint: "show MCP information", command: "/mcp info" },
  { id: "mode-rush", category: "mode", action: "use rush", hint: "switch to rush mode", command: "/mode rush" },
  { id: "mode-smart", category: "mode", action: "use smart", hint: "switch to smart mode", command: "/mode smart" },
  { id: "mode-deep", category: "mode", action: "use deep", hint: "switch to deep mode", command: "/mode deep" },
]

const normalize = (query: string) => query.trim().toLowerCase().replace(/^\//, "")

export const filter = (query: string): ReadonlyArray<Command> => {
  const needle = normalize(query)
  if (needle.length === 0) return commands
  return commands.filter(
    (command) =>
      command.id.includes(needle) ||
      command.category.toLowerCase().includes(needle) ||
      command.action.toLowerCase().includes(needle) ||
      command.hint.toLowerCase().includes(needle) ||
      command.command.toLowerCase().replace(/^\//, "").includes(needle),
  )
}

export const at = (query: string, index: number): Command | undefined => {
  const results = filter(query)
  if (results.length === 0) return undefined
  const clamped = Math.min(Math.max(index, 0), results.length - 1)
  return results[clamped]
}
