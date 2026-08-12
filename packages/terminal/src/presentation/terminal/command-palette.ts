export interface Command {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly keybinding?: string
  readonly action: PaletteAction
}

export type PaletteAction =
  | { readonly _tag: "OpenModePicker" }
  | { readonly _tag: "SwitchThread" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "ToggleFastMode" }
  | { readonly _tag: "ToggleContextDetails" }
  | { readonly _tag: "SetSubagentLimit"; readonly limit: "maxDepth" | "maxSubagents"; readonly value: number }

const subagentLimits = [0, 1, 2, 4, 8, 16] as const

const subagentCommands: ReadonlyArray<Command> = subagentLimits.flatMap((value) => [
  {
    id: `max-subagents-${value}`,
    category: "subagents",
    label: `set max subagents to ${value}`,
    action: { _tag: "SetSubagentLimit", limit: "maxSubagents", value },
  },
  {
    id: `max-depth-${value}`,
    category: "subagents",
    label: `set max depth to ${value}`,
    action: { _tag: "SetSubagentLimit", limit: "maxDepth", value },
  },
])

export const commands: ReadonlyArray<Command> = [
  { id: "threads", category: "thread", label: "switch", keybinding: "Ctrl+T", action: { _tag: "SwitchThread" } },
  { id: "mode", category: "mode", label: "change mode", keybinding: "Ctrl+S", action: { _tag: "OpenModePicker" } },
  {
    id: "context",
    category: "usage",
    label: "show context and usage",
    keybinding: "Ctrl+Y",
    action: { _tag: "ToggleContextDetails" },
  },
  { id: "fast-mode", category: "rika", label: "toggle fast mode", action: { _tag: "ToggleFastMode" } },
  ...subagentCommands,
  { id: "quit", category: "rika", label: "quit", keybinding: "Ctrl+C", action: { _tag: "Quit" } },
]

export const filter = (query: string): ReadonlyArray<Command> => {
  const needle = query.trim().toLowerCase().replace(/^\//, "")
  return needle.length === 0
    ? commands
    : commands.filter((command) => `${command.category} ${command.label}`.toLowerCase().includes(needle))
}
