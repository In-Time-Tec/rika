export interface Command {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly keybinding?: string
  readonly action: PaletteAction
}

export type PaletteAction =
  | { readonly _tag: "NewThread" }
  | { readonly _tag: "NewOrbThread" }
  | { readonly _tag: "OpenModePicker" }
  | { readonly _tag: "SwitchThread" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "ToggleFastMode" }
  | { readonly _tag: "ToggleContextDetails" }
  | { readonly _tag: "EditSubagentLimit"; readonly limit: "maxDepth" | "maxSubagents" }
  | { readonly _tag: "SetSubagentLimit"; readonly limit: "maxDepth" | "maxSubagents"; readonly value: number }

export const commands: ReadonlyArray<Command> = [
  { id: "new-thread", category: "thread", label: "new", action: { _tag: "NewThread" } },
  { id: "new-orb-thread", category: "thread", label: "new in Orb", action: { _tag: "NewOrbThread" } },
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
  {
    id: "max-subagents",
    category: "subagents",
    label: "set max subagents",
    action: { _tag: "EditSubagentLimit", limit: "maxSubagents" },
  },
  {
    id: "max-depth",
    category: "subagents",
    label: "set max depth",
    action: { _tag: "EditSubagentLimit", limit: "maxDepth" },
  },
  { id: "quit", category: "rika", label: "quit", keybinding: "Ctrl+C", action: { _tag: "Quit" } },
]

export const filter = (query: string): ReadonlyArray<Command> => {
  const needle = query.trim().toLowerCase().replace(/^\//, "")
  return needle.length === 0
    ? commands
    : commands.filter((command) => `${command.category} ${command.label}`.toLowerCase().includes(needle))
}
