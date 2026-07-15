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

export const commands: ReadonlyArray<Command> = [
  { id: "threads", category: "thread", label: "switch", keybinding: "Ctrl+T", action: { _tag: "SwitchThread" } },
  { id: "mode", category: "mode", label: "change mode", keybinding: "Ctrl+S", action: { _tag: "OpenModePicker" } },
  { id: "fast-mode", category: "rika", label: "toggle fast mode", action: { _tag: "ToggleFastMode" } },
  { id: "quit", category: "rika", label: "quit", keybinding: "Ctrl+C Ctrl+C", action: { _tag: "Quit" } },
]

export const filter = (query: string): ReadonlyArray<Command> => {
  const needle = query.trim().toLowerCase().replace(/^\//, "")
  return needle.length === 0
    ? commands
    : commands.filter((command) => `${command.category} ${command.label}`.toLowerCase().includes(needle))
}
