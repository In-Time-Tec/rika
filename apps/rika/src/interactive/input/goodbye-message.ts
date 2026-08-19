import type { ModeId } from "@rika/configuration/behavior-mode"
import { homedir } from "node:os"
export type GoodbyeMode = ModeId

export interface GoodbyeInput {
  readonly mode: GoodbyeMode
  readonly workspace: string
  readonly threadId?: string
  readonly threadTitle?: string
}

const modeRgb: Record<GoodbyeMode, readonly [number, number, number]> = {
  low: [255, 215, 0],
  medium: [61, 255, 166],
  high: [61, 212, 255],
  ultra: [216, 179, 255],
}

const glyphs = ["     .#*+:", "   *##%%#+--", "  *#%##%@*=.:", "  +****=....:", "   =::......", "     ....."] as const

const brightness: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 0, 0, 0, 0, 0.314, 0.765, 0.725, 0.663, 0.416],
  [0, 0, 0, 0.765, 0.777, 0.788, 0.84, 0.84, 0.765, 0.639, 0.439, 0.416],
  [0, 0, 0.765, 0.788, 0.827, 0.788, 0.812, 0.851, 0.875, 0.69, 0.514, 0.314, 0.376],
  [0, 0, 0.663, 0.737, 0.753, 0.737, 0.69, 0.541, 0.353, 0.29, 0.267, 0.278, 0.365],
  [0, 0, 0, 0.576, 0.416, 0.376, 0.314, 0.29, 0.278, 0.267, 0.267, 0.314],
  [0, 0, 0, 0, 0, 0.302, 0.267, 0.267, 0.278, 0.365],
]

const reset = "\x1b[0m"
const muted = "\x1b[38;5;8m"
const detailColumn = 17

export const renderGoodbye = (input: GoodbyeInput): string => {
  const home = homedir()
  let workspaceLine = input.workspace.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
  if (input.workspace === home) workspaceLine = "~"
  else if (input.workspace.startsWith(`${home}/`)) workspaceLine = `~${input.workspace.slice(home.length)}`
  const [markR, markG, markB] = modeRgb[input.mode]
  const details = new Map<number, string>([
    [1, input.threadTitle === undefined || input.threadTitle.length === 0 ? "" : input.threadTitle],
    [2, workspaceLine.length === 0 ? "" : `${muted}${workspaceLine}${reset}`],
  ])
  const lines = glyphs.map((glyph, row) => {
    let painted = ""
    for (let column = 0; column < glyph.length; column += 1) {
      const character = glyph[column]!
      if (character === " ") {
        painted += " "
        continue
      }
      const factor = brightness[row]![column] ?? 0
      const r = Math.round(markR * factor)
      const g = Math.round(markG * factor)
      const b = Math.round(markB * factor)
      painted += `\x1b[38;2;${r};${g};${b}m${character}`
    }
    painted += reset
    const detail = details.get(row) ?? ""
    return detail.length === 0 ? painted : `${painted}${" ".repeat(Math.max(1, detailColumn - glyph.length))}${detail}`
  })
  const trailer =
    input.threadId === undefined || input.threadId.length === 0 ? "" : `\n\nrika thread continue ${input.threadId}`
  return `\n${lines.join("\n")}${trailer}\n`
}
