import { Config } from "@rika/core"
import { isFastEligible } from "./view-state"

export interface Command {
  readonly id: string
  readonly category: string
  readonly action: string
  readonly hint: string
  readonly command: string
  readonly key?: string
}

const leadingCommands: ReadonlyArray<Command> = [
  { id: "thread-switch", category: "thread", action: "switch", hint: "switch threads", command: "/switch-thread" },
  {
    id: "amp-relaunch",
    category: "amp",
    action: "relaunch (quit & reopen)",
    hint: "restart the interactive session",
    command: "/relaunch",
  },
  { id: "amp-help", category: "amp", action: "help", hint: "show help", command: "/help" },
  { id: "amp-welcome", category: "amp", action: "show welcome", hint: "show the welcome surface", command: "/welcome" },
  { id: "amp-credits", category: "amp", action: "end credits", hint: "show credits", command: "/credits" },
  { id: "amp-version", category: "amp", action: "show version", hint: "show version", command: "/version" },
  { id: "amp-doctor", category: "amp", action: "doctor", hint: "check local Rika setup", command: "/doctor" },
  { id: "amp-quit", category: "amp", action: "quit", hint: "leave Rika", command: "/exit", key: "Ctrl+C Ctrl+C" },
  {
    id: "ast-grep-outline-status",
    category: "ast-grep",
    action: "ast-grep outline status",
    hint: "show ast-grep outline status",
    command: "/ast-grep outline status",
  },
]

const inspectAllCommand: Command = {
  id: "inspect-open-all",
  category: "inspect",
  action: "open all",
  hint: "open Rika Inspect for all telemetry",
  command: "/inspect all",
}

const inspectThreadCommand: Command = {
  id: "inspect-open-thread",
  category: "inspect",
  action: "open thread",
  hint: "open Rika Inspect for the active thread",
  command: "/inspect thread",
}

const trailingCommands: ReadonlyArray<Command> = [
  {
    id: "mcp-authenticate",
    category: "mcp",
    action: "authenticate",
    hint: "authenticate MCP servers",
    command: "/mcp authenticate",
  },
  { id: "mcp-info", category: "mcp", action: "info", hint: "show MCP information", command: "/mcp info" },
  { id: "mode-rush", category: "mode", action: "use rush", hint: "switch to rush mode", command: "/mode rush" },
  { id: "mode-smart", category: "mode", action: "use smart", hint: "switch to smart mode", command: "/mode smart" },
  { id: "mode-deep1", category: "mode", action: "use deep1", hint: "switch to deep1 mode", command: "/mode deep1" },
  { id: "mode-deep2", category: "mode", action: "use deep2", hint: "switch to deep2 mode", command: "/mode deep2" },
  { id: "mode-deep3", category: "mode", action: "use deep3", hint: "switch to deep3 mode", command: "/mode deep3" },
]

export const commands: ReadonlyArray<Command> = [...leadingCommands, inspectAllCommand, ...trailingCommands]

const speedCommand = (fastMode: boolean): Command => ({
  id: "speed-fast",
  category: "speed",
  action: fastMode ? "use standard speed" : "use fast (2.5x cost)",
  hint: "priority processing for rush & deep",
  command: "/fast",
  key: "Opt+R",
})

export const commandsFor = (mode: Config.Mode, fastMode: boolean, threadActive = false): ReadonlyArray<Command> => {
  const available = [
    ...leadingCommands,
    ...(threadActive ? [inspectThreadCommand, inspectAllCommand] : [inspectAllCommand]),
    ...trailingCommands,
  ]
  return isFastEligible(mode) ? [...available, speedCommand(fastMode)] : available
}

const normalize = (query: string) => query.trim().toLowerCase().replace(/^\//, "")

export const filter = (
  query: string,
  mode: Config.Mode,
  fastMode: boolean,
  threadActive = false,
): ReadonlyArray<Command> => {
  const available = commandsFor(mode, fastMode, threadActive)
  const needle = normalize(query)
  if (needle.length === 0) return available
  return available.filter(
    (command) =>
      command.id.includes(needle) ||
      command.category.toLowerCase().includes(needle) ||
      command.action.toLowerCase().includes(needle) ||
      command.hint.toLowerCase().includes(needle) ||
      command.command.toLowerCase().replace(/^\//, "").includes(needle),
  )
}

export const at = (
  query: string,
  index: number,
  mode: Config.Mode,
  fastMode: boolean,
  threadActive = false,
): Command | undefined => {
  const results = filter(query, mode, fastMode, threadActive)
  if (results.length === 0) return undefined
  const clamped = Math.min(Math.max(index, 0), results.length - 1)
  return results[clamped]
}
