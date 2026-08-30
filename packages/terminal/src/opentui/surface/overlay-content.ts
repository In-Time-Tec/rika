import { bg, dim, fg, StyledText, type TextChunk, type ColorInput } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../../state/model"
import type { ThreadItem } from "../../state/thread/model"
import { Function } from "effect"
import { isLoading } from "../../state/loadable"
import { filteredThreads } from "../../state/thread/navigation"
import { escapeControlCharacters, truncateToWidth } from "../../presentation/terminal/format"
import { relativeTime } from "../../presentation/terminal/relative-time"
import { colors } from "../../presentation/terminal/theme"
const threadAge = (updatedAt: number | undefined, now: number): string =>
  updatedAt === undefined || updatedAt <= 0 ? "" : relativeTime(now - updatedAt)

const threadStats = (thread: ThreadItem): ReadonlyArray<readonly [string, ColorInput]> => {
  if (thread.editTotals === undefined) return []
  return [
    ...(thread.editTotals.added > 0 ? ([[`+${thread.editTotals.added}`, colors.green]] as const) : []),
    ...(thread.editTotals.modified > 0 ? ([[`~${thread.editTotals.modified}`, colors.amber]] as const) : []),
    ...(thread.editTotals.removed > 0 ? ([[`-${thread.editTotals.removed}`, colors.red]] as const) : []),
  ]
}

const threadListRows = (
  model: Model,
  width: number,
  height: number,
  now: number,
): ReadonlyMap<number, ReadonlyArray<TextChunk>> => {
  const threads = filteredThreads(model)
  const listRows = new Map<number, ReadonlyArray<TextChunk>>()
  threads.slice(0, Math.max(1, height - 4)).forEach((thread, index) => {
    const selected = index === model.threadSwitcher.selected
    const age = threadAge(thread.lastActivityAt, now)
    const stats = threadStats(thread)
    const statsWidth = stats.reduce((total, [text]) => total + text.length + 1, 0)
    const rightWidth = statsWidth + (stats.length > 0 && age.length > 0 ? 1 : 0) + age.length
    const titleWidth = Math.max(1, width - rightWidth - 4)
    const safeTitle = escapeControlCharacters(thread.title)
    const title =
      stringWidth(safeTitle) > titleWidth ? `${truncateToWidth(safeTitle, Math.max(0, titleWidth - 1))}…` : safeTitle
    const leftText = `  ${title}`
    const padding = Math.max(1, width - stringWidth(leftText) - rightWidth - 1)
    if (selected) {
      const right = `${stats.map(([text]) => text).join(" ")}${stats.length > 0 && age.length > 0 ? " " : ""}${age}`
      listRows.set(index + 3, [
        bg(colors.selectionBg)(fg(colors.selectionFg)(leftText)),
        bg(colors.selectionBg)(fg(colors.selectionFg)(" ".repeat(padding))),
        bg(colors.selectionBg)(fg(colors.selectionFg)(`${right} `)),
      ])
      return
    }
    const chunks: Array<TextChunk> = [fg(colors.text)(leftText), fg(colors.text)(" ".repeat(padding))]
    stats.forEach(([text, color], statsIndex) => {
      if (statsIndex > 0) chunks.push(fg(colors.text)(" "))
      chunks.push(fg(color)(text))
    })
    if (stats.length > 0 && age.length > 0) chunks.push(fg(colors.text)(" "))
    chunks.push(fg(colors.muted)(`${age} `))
    listRows.set(index + 3, chunks)
  })
  return listRows
}

const threadSwitcherListContentImpl = (model: Model, width: number, height: number, now: number): StyledText => {
  const rows = threadListRows(model, width, height, now)
  const chunks: Array<TextChunk> = []
  for (let row = 0; row < height; row += 1) {
    if (row > 0) chunks.push(fg(colors.text)("\n"))
    const content = rows.get(row)
    if (content === undefined) chunks.push(fg(colors.text)(" ".repeat(width)))
    else {
      chunks.push(...content)
      const used = content.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
      chunks.push(fg(colors.text)(" ".repeat(Math.max(0, width - used))))
    }
  }
  return new StyledText(chunks)
}

export const threadSwitcherListContent: {
  (width: number, height: number, now: number): (model: Model) => StyledText
  (model: Model, width: number, height: number, now: number): StyledText
} = Function.dual(4, threadSwitcherListContentImpl)

const threadSwitcherListWidthImpl = (model: Model, innerWidth: number): number => {
  const layoutWidth = Math.max(1, innerWidth - 1)
  return model.width >= 120 ? Math.max(1, Math.floor((layoutWidth - 2) / 2)) : layoutWidth
}

export const threadSwitcherListWidth: {
  (
    arg1: Parameters<typeof threadSwitcherListWidthImpl>[1],
  ): (arg0: Parameters<typeof threadSwitcherListWidthImpl>[0]) => ReturnType<typeof threadSwitcherListWidthImpl>
  (
    arg0: Parameters<typeof threadSwitcherListWidthImpl>[0],
    arg1: Parameters<typeof threadSwitcherListWidthImpl>[1],
  ): ReturnType<typeof threadSwitcherListWidthImpl>
} = Function.dual(2, threadSwitcherListWidthImpl)

const filePickerContentImpl = (model: Model, entries: ReadonlyArray<string>, innerWidth: number): StyledText => {
  const chunks: Array<TextChunk> = []
  entries.forEach((entry, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const marker = /^@{1,2}/.exec(entry)?.[0] ?? ""
    const rest = entry.slice(marker.length)
    const markerWidth = stringWidth(marker)
    const clipped = truncateToWidth(rest, Math.max(0, innerWidth - markerWidth))
    const padding = " ".repeat(Math.max(0, innerWidth - markerWidth - stringWidth(clipped)))
    if (index === model.filePicker.selected) {
      chunks.push(bg(colors.muted)(fg(colors.teal)(marker)))
      chunks.push(bg(colors.muted)(fg(colors.text)(clipped)))
      chunks.push(bg(colors.muted)(fg(colors.text)(padding)))
    } else {
      chunks.push(fg(colors.teal)(marker))
      chunks.push(fg(colors.text)(clipped))
    }
  })
  if (chunks.length === 0) {
    let emptyMessage = "no matches"
    if (model.filePicker.error !== undefined) emptyMessage = `files unavailable: ${model.filePicker.error}`
    else if (isLoading(model.filePicker.items)) emptyMessage = "Loading files"
    chunks.push(dim(fg(colors.text)(truncateToWidth(emptyMessage, innerWidth))))
  }
  return new StyledText(chunks)
}

export const filePickerContent: {
  (
    arg1: Parameters<typeof filePickerContentImpl>[1],
    arg2: Parameters<typeof filePickerContentImpl>[2],
  ): (arg0: Parameters<typeof filePickerContentImpl>[0]) => ReturnType<typeof filePickerContentImpl>
  (
    arg0: Parameters<typeof filePickerContentImpl>[0],
    arg1: Parameters<typeof filePickerContentImpl>[1],
    arg2: Parameters<typeof filePickerContentImpl>[2],
  ): ReturnType<typeof filePickerContentImpl>
} = Function.dual(3, filePickerContentImpl)
