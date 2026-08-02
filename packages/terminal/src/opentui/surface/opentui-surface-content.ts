import { Function } from "effect"
import { fg, bold, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model, Mode } from "../../state/model/terminal-state"
import { isLoading } from "../../state/model/terminal-loadable-state"
import { activeTimeIcon } from "../../state/model/terminal-activity-time"
import { colors, spacing } from "../../presentation/terminal/terminal-theme"
import { homeRelativePath } from "../../presentation/terminal/terminal-format"
export const panelLoading = (model: Model): string | undefined => {
  if (model.currentThreadId !== undefined && model.refoldingThreadIds.includes(model.currentThreadId))
    return "Rebuilding thread projection"
  if (model.threadLoading) return "Loading Thread"
  if (model.changedFilesOpen && isLoading(model.changedFiles)) return "Loading changed files"
  if ((model.workspaceFilesOpen || model.filePicker.open) && isLoading(model.filePicker.items)) return "Loading files"
  return undefined
}

export const compactWorkspace = (workspace: string): string => {
  const home = homeRelativePath(workspace)
  const segments = home.split("/").filter((segment) => segment.length > 0)
  if (segments.length <= 5) return home
  return [segments.slice(0, 2).join("/"), "…", segments.slice(-2).join("/")].join("/")
}

export const formatCost = (usd: number): string =>
  usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(usd) < 0.01 ? 3 : 2,
  })

export const modeLabelWidth = (text: string): number => stringWidth(text.replaceAll(activeTimeIcon, "x"))

const welcomeMarkFrame = (rows: ReadonlyArray<string>): ReadonlyArray<string> => [
  "                                        ",
  "                                        ",
  "                                        ",
  ...rows.map(shiftWelcomeMarkRow),
]

const shiftWelcomeMarkRow = (row: string): string => ` ${row}`.slice(0, 40)

export const welcomeMarkFrames = [
  welcomeMarkFrame([
    "            •••••••••••••               ",
    "         ••••••••••●●••••••••           ",
    "      •••••●●●●●●●●•••••••••••••        ",
    "    •••••●●●•••••••••••••••••••••       ",
    "   •••••●●•••••••●●●•••••••••••••••     ",
    "  ••••●●•••••●●●•••●●●●●●●••••••••••    ",
    " ••••●●••••●●●•••●●●●●●●●●••••••••••    ",
    " ••••●••••●●•••••••••••••••••••••••••   ",
    "••••••••••●●•••••••••••••••••••••••••   ",
    "••••••••••●●•••••••••••••••••••••••••   ",
    " ••••••••••••••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    •••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         ••••••••••••••••••••           ",
    "             ···········•               ",
  ]),
  welcomeMarkFrame([
    "             ••••••••••••               ",
    "         ••••••••••••••••••••           ",
    "      ••●●•••••●●●•••••••••••••         ",
    "     ••••●●•●●•••••••••••••••••••       ",
    "   ••••●●●●•••••••••••••••••••••••      ",
    "  •••••••••••●●••••••••••••••••••••     ",
    " •••••●●•••●●•••••●●●●●●●•••••••••••    ",
    " ••••●••••●••••••••●●●●•••••••••••••    ",
    " ••••●••••●••••••••••••••••••••••••••   ",
    " •••••••••●●•••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "     ••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         •••••••••••••••••••            ",
    "              ·········•                ",
  ]),
  welcomeMarkFrame([
    "              ••••••••••                ",
    "          ••••••••••••••••••            ",
    "       ●●••••••●●●•••••••••••••         ",
    "     ●●•••••●●•••••••••••••••••••       ",
    "    •••••●●●••••••••••••••••••••••      ",
    "   ••••●●••••••••••••••••••••••••••     ",
    "  ••••●●••••••••••••••••••••••••••••    ",
    " ••••••••••••••••●●●●●●•••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    " ••••●••••●●••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       ••••••••••••••••••••••••         ",
    "          ••••••••••••••••••            ",
    "               ·······•                 ",
  ]),
  welcomeMarkFrame([
    "               ••••••••                 ",
    "          ••●●••••••••••••••            ",
    "       •••••••••••••••••••••••          ",
    "     ••••••●●•••••••••••••••••••        ",
    "    •••••●●•••••••••••••••••••••••      ",
    "   ••••••••••••••••••••••••••••••••     ",
    "  •••••••••••••••••••••••••••••••••     ",
    "  ••••••••••••••●●●●••••••••••••••••    ",
    " •••••••••••••••●●●●••••••••••••••••    ",
    " •••••••••●•••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          ·················             ",
    "                ·····•                  ",
  ]),
  welcomeMarkFrame([
    "                ••••••                  ",
    "          •••••••••••••••••             ",
    "       •••••••••••••••••••••••          ",
    "     •••••••••••••••••••••••••••        ",
    "    •••••••••••••••••••••••••••••       ",
    "   •••••••••••••••••••••••••••••••      ",
    "  •●●••••••••••••••••••••••••••••••     ",
    "  ••••••••••••●●●•••••••••••••••••••    ",
    " ••••••••••••●●●●●●•••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "      ••••••••••••••••••••••••••        ",
    "        ••••••••••••••••••••••          ",
    "          •···············•             ",
    "                 ••••                   ",
  ]),
  welcomeMarkFrame([
    "                •••••                   ",
    "           ••●●••••••••••••             ",
    "        ••••••••••••••••••••••          ",
    "      ••••••••••••••••••••••••••        ",
    "    •●●••••••••••••••••••••••••••       ",
    "   •••••••••••●●••••••••••••••••••      ",
    "  ••••••••••●●•••••••••••••••••••••     ",
    "  ••••••••••●•••••••••••••••••••••••    ",
    "  ••••••••●●●●●●••••••••••••••••••••    ",
    "  •••••••••●●●●●••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "      ••••••••••••••••••••••••••        ",
    "        ••••••••••••••••••••••          ",
    "          •···············•             ",
    "                  ••                    ",
  ]),
  welcomeMarkFrame([
    "                ••••••                  ",
    "          •••••••••••••••••             ",
    "        •●●•••••••••••••••••••          ",
    "      ••••••••••••••••••••••••••        ",
    "    •••••••••••••••••••••••••••••       ",
    "   ••••••••••••••●●●●•••••••••••••      ",
    "  •••••••••••••●●●•••••••••••••••••     ",
    "  •••••••●••••••••••••••••••••••••••    ",
    "  •••••••●●●●●●•••••••••••••••••••••    ",
    "  •••••••●●●●●••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          •···············•             ",
    "                 •••                    ",
  ]),
  welcomeMarkFrame([
    "               ••••••••                 ",
    "          ••••••••••••••••••            ",
    "       •••••••••••••••••••••••          ",
    "     •••••••••••••••••••••••••••        ",
    "    •••••••••••●●●••••••••••••••••      ",
    "   •••••••••●●●••••••••••••••••••••     ",
    "  •••••••••●●●●••••••••••••••••••••     ",
    "  •••••●•••●●●••••••••••••••••••••••    ",
    " ••••••●●●●●●●••••••••••••••••••••••    ",
    " •••••••●●●●●•••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          ·················             ",
    "                ·····•                  ",
  ]),
  welcomeMarkFrame([
    "              ••••••••••                ",
    "         •••••••••••••••••••            ",
    "       ••••••••••••••••••••••••         ",
    "     ••••••••●●●●••••••••••••••••       ",
    "   •••••••●●●•••••••••••••••••••••      ",
    "  ••••••●●●••••••••••••••••••••••••     ",
    "  ••••••●●●•••••••••••••••••••••••••    ",
    " ••••●•●●●●•••••••••••••••••••••••••    ",
    " ••••●●●●●●●●●••••••••••••••••••••••    ",
    " •••••••●●●•••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "     ••••••••••••••••••••••••••••       ",
    "       ••••••••••••••••••••••••         ",
    "         •••••••••••••••••••            ",
    "              •·······•                 ",
  ]),
  welcomeMarkFrame([
    "            •••••••••••••               ",
    "        •••••●●●●●●••••••••••           ",
    "      •••●●●●•••••••••••••••••••        ",
    "    ••●●●●•••••●●••••••••••••••••       ",
    "   ••●●●••••●●●●●••••••••••••••••••     ",
    "  •••●●••••●●●●•••••••••••••••••••••    ",
    " ••●●●•••••●●●●●••••••••••••••••••••    ",
    " ••●●●●●●●●●●••••●●••••••••••••••••••   ",
    " ••••●●●●●●●●••••••••••••••••••••••••   ",
    " •••••••••••●●•••••••••••••••••••••••   ",
    " ••••••••••••••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    •••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         ••••••••••••••••••••           ",
    "             ···········•               ",
  ]),
] as const

const hex2 = (value: number): string => Math.round(value).toString(16).padStart(2, "0")

const welcomeMarkColor = (row: number, _mode: Mode): readonly [number, number, number] => {
  const clamped = Math.max(0, Math.min(1, row))
  const top = [239, 133, 49] as const
  const bottom = [143, 69, 21] as const
  return mix(top, bottom, clamped)
}

const mix = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  tValue: number,
): readonly [number, number, number] => {
  const clamped = Math.max(0, Math.min(1, tValue))
  return [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped, a[2] + (b[2] - a[2]) * clamped]
}

const welcomeContentImpl = (width: number, height: number, phase: number, mode: Mode): StyledText => {
  if (height < 20)
    return new StyledText([
      fg(colors.text)("\n"),
      fg(colors[mode])(`${" ".repeat(Math.max(0, Math.floor((width - 15) / 2)))}Welcome to Rika`),
      fg(colors.text)("\n\n"),
      fg(colors.text)(`${" ".repeat(Math.max(0, Math.floor((width - 24) / 2)))}ctrl+o commands   ? help`),
    ])
  const frame = welcomeMarkFrames[(phase + 5) % welcomeMarkFrames.length] ?? welcomeMarkFrames[0]
  const pattern = frame.slice(3)
  const area = Math.max(1, height - spacing.inputHeight)
  const top = Math.max(0, Math.floor((area - pattern.length) / 2))
  const center = Math.floor(width / 2)
  const logoLeft = Math.max(0, center - 43)
  const textGap = Math.max(1, center - 1 - logoLeft - 40)
  const visiblePattern = pattern.slice(0, Math.max(1, area - top))
  const chunks: TextChunk[] = [fg(colors.text)("\n".repeat(top))]
  const copy = new Map<number, ReadonlyArray<TextChunk>>([
    [4, [bold(fg(colors[mode])("Welcome to Rika"))]],
    [7, [bold(fg(colors.text)("ctrl+o")), fg(colors.muted)(" for commands")]],
    [8, [bold(fg(colors.text)("?")), fg(colors.muted)(" for shortcuts")]],
  ])
  for (let row = 0; row < visiblePattern.length; row += 1) {
    if (row > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors.text)(" ".repeat(logoLeft)))
    for (const glyph of visiblePattern[row] ?? "") {
      if (glyph === " ") chunks.push(fg(colors.text)(glyph))
      else {
        const [red, green, blue] = welcomeMarkColor(row / 17, mode)
        chunks.push(fg(`#${hex2(red)}${hex2(green)}${hex2(blue)}`)(glyph))
      }
    }
    const suffix = copy.get(row)
    if (suffix !== undefined) {
      chunks.push(fg(colors.text)(" ".repeat(textGap)))
      chunks.push(...suffix)
    }
  }
  return new StyledText(chunks)
}

export const welcomeContent: {
  (
    arg1: Parameters<typeof welcomeContentImpl>[1],
    arg2: Parameters<typeof welcomeContentImpl>[2],
    arg3: Parameters<typeof welcomeContentImpl>[3],
  ): (arg0: Parameters<typeof welcomeContentImpl>[0]) => ReturnType<typeof welcomeContentImpl>
  (
    arg0: Parameters<typeof welcomeContentImpl>[0],
    arg1: Parameters<typeof welcomeContentImpl>[1],
    arg2: Parameters<typeof welcomeContentImpl>[2],
    arg3: Parameters<typeof welcomeContentImpl>[3],
  ): ReturnType<typeof welcomeContentImpl>
} = Function.dual(4, welcomeContentImpl)
