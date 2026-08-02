import type { InteractiveCommand } from "@rika/product/interactive-command"

export interface PaletteCommand {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly action: unknown
}

export const paletteCommands = [
  { id: "new-thread", category: "thread", label: "New thread", action: { _tag: "NewThread" as const } },
] as const

export const installPaletteCommands = (commands: Array<PaletteCommand>): void => {
  for (const command of paletteCommands.toReversed())
    if (!commands.some((candidate) => candidate.id === command.id)) commands.unshift(command)
}

export const paletteCommand = (action: unknown): InteractiveCommand | undefined =>
  action !== null && typeof action === "object" && "_tag" in action && action._tag === "NewThread"
    ? { _tag: "NewThread" }
    : undefined
