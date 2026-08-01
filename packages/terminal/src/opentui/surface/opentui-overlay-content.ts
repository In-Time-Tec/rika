import { bg, dim, fg, StyledText, type TextChunk, type ColorInput } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../../state/model/terminal-state"
import type { ThreadItem } from "../../state/model/terminal-thread-state"
import { Clock, Effect, Function } from "effect"
import { initial, type Mode } from "../../state/model/terminal-state"
import { isLoading } from "../../state/model/terminal-loadable-state"
import { selectedThreadMetadata, filteredThreads } from "../../state/model/terminal-thread-navigation"
import { escapeControlCharacters } from "../../presentation/terminal/terminal-format"
import { relativeTime } from "../../presentation/terminal/terminal-relative-time"
import { colors } from "../../presentation/terminal/terminal-theme"
import { truncateToWidth } from "../../presentation/terminal/terminal-format"
import { renderTranscriptStyled } from "../rendering/opentui-renderer"
import { projectUnits } from "../../presentation/transcript/terminal-transcript-projection"
type ThreadPreviewValue = Extract<Model["threadPreview"], { _tag: "Ready" }>["value"]
const threadAge = (updatedAt: number | undefined, now: number): string =>
  updatedAt === undefined || updatedAt <= 0 ? "" : relativeTime(now - updatedAt)

export const splitStyledLines = (styled: StyledText): Array<Array<TextChunk>> => {
  const lines: Array<Array<TextChunk>> = [[]]
  for (const chunk of styled.chunks) {
    const pieces = chunk.text.split("\n")
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length > 0) lines[lines.length - 1]!.push({ ...chunk, text: piece })
    })
  }
  return lines
}

export const clipStyledLine: {
  (line: ReadonlyArray<TextChunk>, width: number): Array<TextChunk>
  (width: number): (line: ReadonlyArray<TextChunk>) => Array<TextChunk>
} = Function.dual(2, (line: ReadonlyArray<TextChunk>, width: number): Array<TextChunk> => {
  const out: Array<TextChunk> = []
  let used = 0
  for (const chunk of line) {
    if (used >= width) break
    const remaining = width - used
    const text = stringWidth(chunk.text) > remaining ? truncateToWidth(chunk.text, remaining) : chunk.text
    if (text.length === 0) continue
    out.push({ ...chunk, text })
    used += stringWidth(text)
  }
  return out
})

const previewTranscriptCache = new WeakMap<ThreadPreviewValue, Map<string, ReadonlyArray<ReadonlyArray<TextChunk>>>>()

const renderPreviewTranscript = (
  preview: ThreadPreviewValue,
  workspace: string,
  mode: Mode,
  width: number,
): ReadonlyArray<ReadonlyArray<TextChunk>> => {
  const key = `${workspace}\0${mode}\0${width}`
  const cached = previewTranscriptCache.get(preview)?.get(key)
  if (cached !== undefined) return cached
  let previewModel: Model = { ...initial(workspace, mode), width: Math.max(8, width), height: 200 }
  preview.turns.forEach((turn) => {
    previewModel = projectUnits(previewModel, turn.units)
  })
  const lines = splitStyledLines(renderTranscriptStyled(previewModel)).map((line) => clipStyledLine(line, width))
  const cachedWidths = previewTranscriptCache.get(preview) ?? new Map()
  cachedWidths.set(key, lines)
  previewTranscriptCache.set(preview, cachedWidths)
  return lines
}

const previewTranscriptLines = (
  model: Model,
  width: number,
  maxRows: number,
):
  | {
      readonly lines: ReadonlyArray<ReadonlyArray<TextChunk>>
      readonly total: number
      readonly start: number
    }
  | undefined => {
  const selected = selectedThreadMetadata(model)
  let preview: Extract<Model["threadPreview"], { _tag: "Ready" }>["value"] | undefined
  if (model.threadPreview._tag === "Ready") {
    if (selected?.id === model.threadPreview.value.threadId) preview = model.threadPreview.value
  } else if (model.threadPreview._tag === "Loading") preview = model.threadPreview.previous
  if (preview === undefined || preview.turns.length === 0) return undefined
  const lines = renderPreviewTranscript(preview, model.workspace, model.mode, width)
  const rows = Math.max(1, maxRows)
  const offset = Math.min(model.threadSwitcher.previewScroll, Math.max(0, lines.length - rows))
  const end = lines.length - offset
  const start = Math.max(0, end - rows)
  return { lines: lines.slice(start, end), total: lines.length, start }
}

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

export const previewBoxRows: {
  (model: Model, width: number, height: number): ReadonlyMap<number, ReadonlyArray<TextChunk>>
  (width: number, height: number): (model: Model) => ReadonlyMap<number, ReadonlyArray<TextChunk>>
} = Function.dual(3, (model: Model, width: number, height: number): ReadonlyMap<number, ReadonlyArray<TextChunk>> => {
  const rows = new Map<number, ReadonlyArray<TextChunk>>()
  if (width < 8 || height < 4) return rows
  const inner = width - 2
  const preview = selectedThreadMetadata(model)
  const contentWidth = Math.max(1, inner - 3)
  const details =
    preview === undefined
      ? []
      : [
          escapeControlCharacters(preview.title),
          preview.workspace,
          [preview.archived ? "archived" : "", preview.unread ? "unread" : "", preview.status]
            .filter((value) => value.length > 0)
            .join(" · "),
        ].filter((value) => value.length > 0)
  const contentRows = Math.max(1, height - 4 - details.length)
  const transcript = previewTranscriptLines(model, contentWidth, contentRows)
  rows.set(0, [fg(colors.muted)(`╭${"─".repeat(inner)}╮`)])
  const header = "Thread Preview"
  const headerLeft = Math.max(0, Math.floor((inner - header.length) / 2))
  rows.set(1, [
    fg(colors.muted)("│"),
    fg(colors.text)(" ".repeat(headerLeft)),
    fg(colors.muted)(header),
    fg(colors.text)(" ".repeat(Math.max(0, inner - headerLeft - header.length))),
    fg(colors.muted)("│"),
  ])
  details.forEach((line, index) => {
    const visible = truncateToWidth(line, contentWidth)
    rows.set(2 + index, [
      fg(colors.muted)("│"),
      fg(colors.text)("  "),
      fg(colors.text)(visible),
      fg(colors.text)(" ".repeat(Math.max(0, contentWidth - stringWidth(visible)))),
      fg(colors.text)(" "),
      fg(colors.muted)("│"),
    ])
  })
  if (transcript !== undefined) {
    const startRow = height - 1 - transcript.lines.length
    const scrollable = transcript.total > contentRows
    const thumb = scrollable
      ? Math.round((transcript.start / Math.max(1, transcript.total - contentRows)) * Math.max(0, contentRows - 1))
      : -1
    transcript.lines.forEach((line, index) => {
      const textWidth = line.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
      const contentRow = startRow + index
      rows.set(contentRow, [
        fg(colors.muted)("│"),
        fg(colors.text)("  "),
        ...line,
        fg(colors.text)(" ".repeat(Math.max(0, contentWidth - textWidth))),
        scrollable ? fg(colors.muted)(contentRow - 2 === thumb ? "█" : "│") : fg(colors.text)(" "),
        fg(colors.muted)("│"),
      ])
    })
  } else if (!isLoading(model.threadPreview)) {
    const status = "No preview"
    const statusLeft = Math.max(0, Math.floor((inner - status.length) / 2))
    rows.set(2 + details.length, [
      fg(colors.muted)("│"),
      fg(colors.text)(" ".repeat(statusLeft)),
      dim(fg(colors.text)(status)),
      fg(colors.text)(" ".repeat(Math.max(0, inner - statusLeft - status.length))),
      fg(colors.muted)("│"),
    ])
  }
  for (let row = 2; row < height - 1; row += 1)
    if (!rows.has(row))
      rows.set(row, [fg(colors.muted)("│"), fg(colors.text)(" ".repeat(inner)), fg(colors.muted)("│")])
  rows.set(height - 1, [fg(colors.muted)(`╰${"─".repeat(inner)}╯`)])
  return rows
})

const threadSwitcherContentImpl = (model: Model, innerWidth: number, innerHeight: number): StyledText => {
  const horizontal = model.width >= 120
  const showPreview = horizontal || innerHeight >= 9
  const layoutWidth = Math.max(1, innerWidth - 1)
  const listWidth = threadSwitcherListWidth(model, innerWidth)
  let listHeight = innerHeight
  if (!horizontal && showPreview) {
    listHeight = Math.max(5, Math.min(innerHeight - 4, Math.floor(innerHeight * 0.42)))
  }
  const previewWidth = horizontal ? Math.max(1, layoutWidth - listWidth - 2) : layoutWidth
  const previewHeight = horizontal ? Math.max(4, innerHeight - 3) : Math.max(4, innerHeight - listHeight - 2)
  const previewTop = horizontal ? 1 : listHeight
  const now = Effect.runSync(Clock.currentTimeMillis)
  const listRows = threadListRows(model, listWidth, listHeight, now)
  const previewRows = previewBoxRows(model, previewWidth, previewHeight)
  const chunks: Array<TextChunk> = []
  for (let row = 0; row < innerHeight; row += 1) {
    if (row > 0) chunks.push(fg(colors.text)("\n"))
    if (!horizontal && showPreview && row >= previewTop) {
      const previewRow = previewRows.get(row - previewTop)
      if (previewRow !== undefined) chunks.push(...previewRow)
      continue
    }
    if (row === 1 && row < listHeight) {
      chunks.push(fg(colors.text)(" ".repeat(listWidth)))
    } else {
      const listRow = listRows.get(row)
      if (listRow === undefined) chunks.push(fg(colors.text)(" ".repeat(listWidth)))
      else {
        chunks.push(...listRow)
        const used = listRow.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
        chunks.push(fg(colors.text)(" ".repeat(Math.max(0, listWidth - used))))
      }
    }
    if (horizontal) {
      chunks.push(fg(colors.text)("  "))
      chunks.push(...(previewRows.get(row - previewTop) ?? [fg(colors.text)(" ".repeat(previewWidth))]))
    }
  }
  return new StyledText(chunks)
}

export const threadSwitcherContent: {
  (
    arg1: Parameters<typeof threadSwitcherContentImpl>[1],
    arg2: Parameters<typeof threadSwitcherContentImpl>[2],
  ): (arg0: Parameters<typeof threadSwitcherContentImpl>[0]) => ReturnType<typeof threadSwitcherContentImpl>
  (
    arg0: Parameters<typeof threadSwitcherContentImpl>[0],
    arg1: Parameters<typeof threadSwitcherContentImpl>[1],
    arg2: Parameters<typeof threadSwitcherContentImpl>[2],
  ): ReturnType<typeof threadSwitcherContentImpl>
} = Function.dual(3, threadSwitcherContentImpl)

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
