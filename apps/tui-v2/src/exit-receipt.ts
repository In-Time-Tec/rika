import { homedir } from "node:os"
import { Function } from "effect"
import type { ClientState, Mode, ScenarioId } from "./client/model"

export interface ExitReceipt {
  readonly title: string
  readonly workspace: string
  readonly mode: Mode
  readonly scenario: ScenarioId
}

export const captureExitReceipt: {
  (state: ClientState, workspace: string): ExitReceipt
  (workspace: string): (state: ClientState) => ExitReceipt
} = Function.dual(
  2,
  (state: ClientState, workspace: string): ExitReceipt => ({
    title: state.threads.find((thread) => thread.id === state.selectedThreadId)?.title ?? "Rika",
    workspace,
    mode: state.mode,
    scenario: state.scenario,
  }),
)

const modeRgb = {
  low: [255, 215, 0],
  medium: [61, 255, 166],
  high: [61, 212, 255],
  ultra: [216, 179, 255],
} as const

const glyphs = ["     .#*+:", "   *##%%#+--", "  *#%##%@*=.:", "  +****=....:", "   =::......", "     ....."] as const
const brightness = [
  [0, 0, 0, 0, 0, 0.314, 0.765, 0.725, 0.663, 0.416],
  [0, 0, 0, 0.765, 0.777, 0.788, 0.84, 0.84, 0.765, 0.639, 0.439, 0.416],
  [0, 0, 0.765, 0.788, 0.827, 0.788, 0.812, 0.851, 0.875, 0.69, 0.514, 0.314, 0.376],
  [0, 0, 0.663, 0.737, 0.753, 0.737, 0.69, 0.541, 0.353, 0.29, 0.267, 0.278, 0.365],
  [0, 0, 0, 0.576, 0.416, 0.376, 0.314, 0.29, 0.278, 0.267, 0.267, 0.314],
  [0, 0, 0, 0, 0, 0.302, 0.267, 0.267, 0.278, 0.365],
] as const

const reset = "\x1b[0m"
const safeLine = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, " ")

export const renderExitReceipt = (input: ExitReceipt): string => {
  const home = homedir()
  let workspace = input.workspace
  if (workspace === home) workspace = "~"
  else if (workspace.startsWith(`${home}/`)) workspace = `~${workspace.slice(home.length)}`
  const rgb = modeRgb[input.mode]
  const lines = glyphs.map((glyph, row) => {
    const painted = [...glyph]
      .map((character, column) => {
        if (character === " ") return character
        const factor = brightness[row]?.[column] ?? 0
        return `\x1b[38;2;${rgb.map((channel) => Math.round(channel * factor)).join(";")}m${character}`
      })
      .join("")
    let detail = ""
    if (row === 1) detail = safeLine(input.title)
    else if (row === 2) detail = `\x1b[38;2;102;102;102m${safeLine(workspace)}${reset}`
    return `${painted}${reset}${detail.length > 0 ? `${" ".repeat(17 - glyph.length)}${detail}` : ""}`
  })
  return `\n${lines.join("\n")}\n\nOffline demo — relaunch scenario (not a saved session):\nbun run tui-v2 --scenario ${input.scenario}`
}
