import { Function } from "effect"
import { bold, bg, dim, fg, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../../state/model/terminal-state"
import { modeIds } from "@rika/configuration/behavior-mode"
import { colors } from "../../presentation/terminal/terminal-theme"
import { displayInput } from "../../state/model/terminal-composer-state"
import { truncateToWidth } from "../../presentation/terminal/terminal-format"
import type { Command } from "../../presentation/terminal/command-palette"
import type { ModeRouteLabel } from "../../state/model/terminal-mode-route"
const displayCursorOffset = (model: Model): number => {
  let offset = model.cursor
  for (const attachment of model.pastedText) {
    const tokenOffset = model.input.indexOf(attachment.token)
    if (tokenOffset >= 0 && tokenOffset < model.cursor) offset += attachment.label.length - attachment.token.length
  }
  return offset
}

const composerTextChunks = (model: Model, visibleRows = 3): Array<TextChunk> => {
  const displayed = displayInput(model)
  const cursor = Math.max(0, Math.min(displayed.length, displayCursorOffset(model)))
  const before = displayed.slice(0, cursor)
  const lines = displayed.split("\n")
  const cursorLine = before.split("\n").length - 1
  const firstLine = Math.max(0, Math.min(cursorLine - visibleRows + 1, lines.length - visibleRows))
  const chunks: Array<TextChunk> = []
  lines.slice(firstLine, firstLine + visibleRows).forEach((line, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors.text)(line))
  })
  return chunks
}

const shortcutRows: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [
    ["Ctrl+O", "command palette"],
    ["Ctrl+R", "prompt history"],
  ],
  [
    ["Ctrl+V", "paste images"],
    ["Shift+Enter", "newline"],
  ],
  [["Ctrl+S", "switch modes"]],
  [
    ["Ctrl+G", "edit in $EDITOR"],
    ["Opt+T", "toggle file tree"],
  ],
  [
    ["@ / @@", "mention files/threads"],
    ["Tab/Shift+Tab", "navigate messages"],
  ],
  [["?", "toggle this help"]],
]

const sidebarShortcutRows: ReadonlyArray<readonly [string, string]> = [
  ["Opt+S", "toggle changed files"],
  ["Enter", "open selected thread"],
]

const shortcutsContentImpl = (model: Model, innerWidth: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const secondColumn = 32
  const rows =
    innerWidth >= 70
      ? shortcutRows
      : shortcutRows.flatMap((row) => row.map((pair) => [pair] as ReadonlyArray<readonly [string, string]>))
  for (const row of rows) {
    let column = 0
    row.forEach(([keys, description], index) => {
      if (index === 1) {
        chunks.push(fg(colors.text)(" ".repeat(Math.max(1, secondColumn - column))))
        column = secondColumn
      }
      chunks.push(fg(colors.blue)(keys))
      chunks.push(fg(colors.text)(` ${description}`.slice(0, Math.max(0, innerWidth - keys.length))))
      column += keys.length + description.length + 1
    })
    chunks.push(fg(colors.text)("\n"))
  }
  chunks.push(fg(colors.text)("\n"))
  chunks.push(bold(fg(colors.amber)("Sidebar")))
  chunks.push(fg(colors.text)("\n"))
  for (const [keys, description] of sidebarShortcutRows) {
    chunks.push(fg(colors.blue)(keys))
    chunks.push(fg(colors.text)(` ${description}`))
    chunks.push(fg(colors.text)("\n"))
  }
  chunks.push(fg(colors.text)("\n"))
  chunks.push(dim(fg(colors.text)("─".repeat(Math.max(1, innerWidth)))))
  chunks.push(fg(colors.text)("\n"))
  chunks.push(...composerTextChunks(model))
  return new StyledText(chunks)
}

export const shortcutsContent: {
  (
    arg1: Parameters<typeof shortcutsContentImpl>[1],
  ): (arg0: Parameters<typeof shortcutsContentImpl>[0]) => ReturnType<typeof shortcutsContentImpl>
  (
    arg0: Parameters<typeof shortcutsContentImpl>[0],
    arg1: Parameters<typeof shortcutsContentImpl>[1],
  ): ReturnType<typeof shortcutsContentImpl>
} = Function.dual(2, shortcutsContentImpl)

const paletteContentImpl = (
  model: Model,
  results: ReadonlyArray<Command>,
  innerWidth: number,
  innerHeight: number,
): StyledText => {
  const compact = innerHeight < results.length + 3
  const chunks: Array<TextChunk> = compact ? [] : [fg(colors.text)("\n")]
  chunks.push(fg(colors.text)(compact ? "\n" : "\n\n"))
  const categoryWidth = 16
  results.forEach((command, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const selected = index === model.palette.selected
    const keybinding = command.keybinding ?? ""
    const label = command.label
    if (innerWidth < 48) {
      const visible = truncateToWidth(label, innerWidth)
      const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(visible)))
      chunks.push(
        selected
          ? bold(bg(colors.selectionBg)(fg(colors.selectionFg)(`${visible}${padding}`)))
          : bold(fg(colors.text)(visible)),
      )
      return
    }
    const category = command.category.padStart(categoryWidth)
    const used = categoryWidth + 2 + label.length
    const padding = Math.max(1, innerWidth - used - keybinding.length - 1)
    if (selected) {
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(category)))
      chunks.push(bold(bg(colors.selectionBg)(fg(colors.selectionFg)(`  ${label}`))))
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(" ".repeat(padding))))
      if (keybinding.length > 0) chunks.push(bold(bg(colors.selectionBg)(fg(colors.selectionHint)(keybinding))))
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(" ")))
    } else {
      chunks.push(dim(fg(colors.text)(category)))
      chunks.push(bold(fg(colors.text)(`  ${label}`)))
      chunks.push(fg(colors.text)(" ".repeat(padding)))
      if (keybinding.length > 0) chunks.push(bold(fg(colors.blue)(keybinding)))
      chunks.push(fg(colors.text)(" "))
    }
  })
  return new StyledText(chunks)
}

const routeLabel = (route: ModeRouteLabel | undefined): string =>
  route === undefined ? "" : `${route.name} ${route.effort}${route.fast ? " fast" : ""}`
const modeDescription = {
  low: "Fast, low-cost mode for small, well-defined tasks",
  medium: "Balanced default for everyday work",
  high: "Deep reasoning for hard tasks",
  ultra: "The most capable mode for hard, open-ended tasks",
} as const

export const paletteContent: {
  (
    arg1: Parameters<typeof paletteContentImpl>[1],
    arg2: Parameters<typeof paletteContentImpl>[2],
    arg3: Parameters<typeof paletteContentImpl>[3],
  ): (arg0: Parameters<typeof paletteContentImpl>[0]) => ReturnType<typeof paletteContentImpl>
  (
    arg0: Parameters<typeof paletteContentImpl>[0],
    arg1: Parameters<typeof paletteContentImpl>[1],
    arg2: Parameters<typeof paletteContentImpl>[2],
    arg3: Parameters<typeof paletteContentImpl>[3],
  ): ReturnType<typeof paletteContentImpl>
} = Function.dual(4, paletteContentImpl)

export const modeLabelStarts = (innerWidth: number): ReadonlyArray<number> =>
  modeIds.map((_, index) => Math.floor((index * Math.max(0, innerWidth - 5)) / (modeIds.length - 1)))

const modePickerContentImpl = (model: Model, innerWidth: number): StyledText => {
  const selected = modeIds[model.modePicker.selected] ?? model.mode
  const compact = innerWidth < 40 || model.height <= 12
  const chunks: Array<TextChunk> = []
  const line = (value = "", style: (text: string) => TextChunk = fg(colors.text)) => {
    if (chunks.length > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(style(truncateToWidth(value, innerWidth)))
  }
  if (compact) {
    line(selected, (value) => bold(fg(colors[selected])(value)))
    line(model.height <= 12 ? routeLabel(model.modeRoutes[selected]?.main) : modeDescription[selected], (value) =>
      fg(colors.muted)(value),
    )
    return new StyledText(chunks)
  }
  const starts = modeLabelStarts(innerWidth)
  const targetPosition = model.modePicker.selected
  const fromPosition = model.modePicker.fromPosition ?? model.modePicker.from ?? targetPosition
  const progress = Math.min(1, ((model.modePicker.turnTick ?? 4) + 1) / 4)
  const position = fromPosition + (targetPosition - fromPosition) * (1 - (1 - progress) * (1 - progress))
  const center = Math.round((position * Math.max(0, innerWidth - 5)) / Math.max(1, modeIds.length - 1))
  const target = starts[model.modePicker.selected] ?? 0
  const from = Math.round((fromPosition * Math.max(0, innerWidth - 5)) / Math.max(1, modeIds.length - 1))
  const thumbWidth = selected.length
  const dial = Array.from({ length: innerWidth }, () => "╌")
  for (let index = 0; index < thumbWidth; index += 1) if (center + index < dial.length) dial[center + index] = "━"
  if (model.modePicker.turnTick !== undefined) {
    const edge = target >= from ? center + thumbWidth : center - 1
    if (edge >= 0 && edge < dial.length) dial[edge] = "╾"
  }
  line("")
  line(dial.join(""), (value) => fg(colors[selected])(value))
  const labels: Array<TextChunk> = []
  let column = 0
  for (const [index, mode] of modeIds.entries()) {
    const start = starts[index]!
    labels.push(fg(colors.text)(" ".repeat(Math.max(0, start - column))))
    labels.push(mode === selected ? bold(fg(colors[selected])(mode)) : dim(fg(colors.text)(mode)))
    column = start + mode.length
  }
  chunks.push(fg(colors.text)("\n"), ...labels)
  line("")
  line(" ".repeat(innerWidth))
  line("")
  const routes = model.modeRoutes[selected]
  line(`Agent     ${routeLabel(routes?.main)}`)
  line(`Oracle    ${routeLabel(routes?.oracle)}`)
  line("")
  line(" ".repeat(innerWidth))
  line("")
  line(modeDescription[selected])
  line("")
  return new StyledText(chunks)
}

export const modePickerContent: {
  (
    arg1: Parameters<typeof modePickerContentImpl>[1],
  ): (arg0: Parameters<typeof modePickerContentImpl>[0]) => ReturnType<typeof modePickerContentImpl>
  (
    arg0: Parameters<typeof modePickerContentImpl>[0],
    arg1: Parameters<typeof modePickerContentImpl>[1],
  ): ReturnType<typeof modePickerContentImpl>
} = Function.dual(2, modePickerContentImpl)
