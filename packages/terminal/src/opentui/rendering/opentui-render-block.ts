import type { ColorInput, TextChunk } from "@opentui/core"
import { Function } from "effect"
import { subagentPhrase } from "@rika/transcript/subagent-presentation"
import { cellBodyText, cellCollapsedLine } from "@rika/transcript/cell-presentation"
import stringWidth from "string-width"
import type { TranscriptBlock } from "../../state/model/terminal-transcript-state"
import type { ChangedFile } from "../../state/model/terminal-changed-file"
import type { Model } from "../../state/model/terminal-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { escapeControlCharacters, formatBytes, truncateToWidth } from "../../presentation/terminal/terminal-format"
import { renderDiff } from "../../presentation/tool/diff-renderer"
import { fg, dim, bg, underline, StyledText } from "@opentui/core"
import { boundedThreadSidebarWidth } from "../../state/model/terminal-layout-state"
import { fileSidebarLayoutWidth } from "../../state/model/terminal-layout-state"
import type { ThreadItem } from "../../state/model/terminal-thread-state"
import { isThreadBusy } from "../../state/model/terminal-thread-predicate"
import { toOpenColor } from "./terminal-text-adapter"

const idleSpinnerFrame = "⠭"
const compactionGlyphCapabilities = { floral: true } as const
export const completedCompactionIcon = compactionGlyphCapabilities.floral ? "❋" : "*"
const toOpenStyledChunk = (chunk: TextChunk): TextChunk =>
  chunk.fg === undefined ? chunk : Object.assign({}, chunk, { fg: toOpenColor(chunk.fg) })
const wrapTextToWidth = (text: string, width: number): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const hardLine of text.split("\n")) {
    let rest = hardLine
    while (stringWidth(rest) > width) {
      let end = 0
      let breakAt = 0
      let used = 0
      for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(rest)) {
        const cells = stringWidth(segment)
        if (used + cells > width) break
        used += cells
        end = index + segment.length
        if (/\s/u.test(segment)) breakAt = end
      }
      let split = breakAt
      if (split === 0) split = end
      if (split === 0) split = rest[0]?.length ?? rest.length
      lines.push(rest.slice(0, split).trimEnd())
      rest = rest.slice(split).trimStart()
    }
    lines.push(rest)
  }
  return lines
}
const wrapBodyText = (text: string, width: number, indent: string): string =>
  wrapTextToWidth(text, Math.max(1, width - stringWidth(indent)))
    .map((line) => `${indent}${line}`)
    .join("\n")
const iconChar = (failed: boolean, running: boolean, frame = idleSpinnerFrame, cancelled = false): string => {
  if (running) return frame
  if (cancelled) return "⊘"
  return failed ? "✕" : "✓"
}
export const renderBlock: {
  (width?: number): (block: TranscriptBlock) => string
  (block: TranscriptBlock): string
  (block: TranscriptBlock, width?: number): string
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "number",
  (block: TranscriptBlock, width = 80): string => {
    const body = (text: string) => wrapBodyText(text, width, "  ")
    const head = (text: string) => {
      const lines = wrapTextToWidth(text, Math.max(1, width))
      const rest = lines.slice(1).join(" ")
      return rest.length === 0 ? lines[0]! : `${lines[0]}\n${body(rest)}`
    }
    switch (block._tag) {
      case "Reasoning":
        return `◇ Reasoning\n${body(block.text)}`
      case "ToolCall": {
        const running = block.status === "running"
        const icon = iconChar(block.status === "failed", running, "⠿", block.status === "cancelled")
        const label = running ? block.presentation.activeLabel : block.presentation.completeLabel
        return `${icon} ${label}${block.detail.length === 0 ? "" : ` ${block.detail}`}`
      }
      case "ToolResult":
        return `${block.failed ? "✕" : "✓"} Result\n${body(block.output)}`
      case "Diff":
        return `Δ ${block.path}\n${renderDiff(block.patch, width)}`
      case "ContextUsage":
        return `◷ Context ${block.text}${block.cost === undefined ? "" : ` · ${block.cost}`}`
      case "Compaction":
        if (block.status === "running") return "↻ Auto-compacting context…"
        if (block.status === "failed") return `✗ Auto-compaction failed\n${body(block.summary)}`
        if (block.status === "cancelled") return "⊘ Auto-compaction cancelled"
        return `${completedCompactionIcon} Auto-compacted${block.summary.length === 0 ? "" : `\n${body(block.summary)}`}`
      case "Notification":
        return `${head(`! ${block.title}`)}\n${body(block.detail)}`
      case "Error": {
        const title = wrapTextToWidth(block.title, Math.max(1, width)).join("\n")
        const detail =
          block.detail.length === 0 ? "" : `\n${wrapTextToWidth(block.detail, Math.max(1, width)).join("\n")}`
        return `${title}${detail}`
      }
      case "SubagentCard": {
        let icon = "✗"
        if (block.status === "queued") icon = "◷"
        else if (block.status === "running" || block.status === "waiting" || block.status === "cancelling") icon = "⠿"
        else if (block.status === "complete") icon = "✓"
        else if (block.status === "cancelled") icon = "⊘"
        const detail = block.summary.length === 0 ? block.prompt : block.summary
        return `${icon} ${subagentPhrase(block.name, block.status)} ▸${detail.length === 0 ? "" : `\n${body(detail)}`}`
      }
      case "AuthorizationCard": {
        let icon = "✕"
        if (block.status === "pending") icon = "?"
        else if (block.status === "approved") icon = "✓"
        return `${icon} Authorization ${block.status}: ${block.operation} · ${block.capability}`
      }
      case "ImageAttachment": {
        const dimensions =
          block.width !== undefined && block.height !== undefined ? ` · ${block.width}×${block.height}` : ""
        const size = block.bytes === undefined ? "" : ` · ${formatBytes(block.bytes)}`
        return `▧ ${block.name} · ${block.mediaType}${dimensions}${size}`
      }
      case "Cell": {
        const running = block.status === "running"
        const icon = iconChar(
          block.status === "failed" || block.status === "unknown",
          running,
          "⠿",
          block.status === "cancelled",
        )
        const detail = cellCollapsedLine(block)
        const output = cellBodyText(block)
        return `${icon} ${detail}${output.length === 0 ? "" : `\n${body(output)}`}`
      }
    }
  },
)

export const renderSidebar: {
  (spinnerFrame?: string): (model: Model) => StyledText
  (model: Model): StyledText
  (model: Model, spinnerFrame?: string): StyledText
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "string",
  (model, spinnerFrame = "⠭"): StyledText => {
    const chunks: Array<TextChunk> = []
    const threads = model.threads as ReadonlyArray<ThreadItem>
    const sidebarWidth = boundedThreadSidebarWidth(model.width)
    threads
      .slice(model.threadSidebar.scrollTop, model.threadSidebar.scrollTop + model.height)
      .forEach((thread, row) => {
        const index = row + model.threadSidebar.scrollTop
        if (row > 0) chunks.push(fg(colors.text)("\n"))
        const selected: boolean = model.threadSidebar.focused === true && index === model.threadSidebar.selected
        let marker = " "
        if (thread.id === model.currentThreadId) marker = "*"
        else if (isThreadBusy(thread.status)) marker = spinnerFrame
        else if (thread.unread) marker = "○"
        const title = truncateToWidth(escapeControlCharacters(thread.title), sidebarWidth - 4)
        const padding = " ".repeat(Math.max(0, sidebarWidth - 4 - stringWidth(title)))
        const renderedRow = ` ${marker} ${title}${padding}`
        if (selected) chunks.push(bg(colors.amber)(fg(colors.surface)(renderedRow)))
        else {
          chunks.push(fg(colors.text)(" "))
          let styledMarker = fg(colors.text)(marker)
          if (thread.id === model.currentThreadId) styledMarker = fg(colors.green)(marker)
          else if (isThreadBusy(thread.status)) styledMarker = fg(colors.blue)(marker)
          else if (thread.unread) styledMarker = dim(fg(colors.blue)(marker))
          chunks.push(styledMarker)
          chunks.push(fg(colors.text)(` ${title}${padding}`))
        }
        chunks.push(dim(fg(colors.text)("│")))
      })
    return new StyledText(chunks.map(toOpenStyledChunk))
  },
)

interface ChangedNode {
  readonly children: Map<string, ChangedNode>
  file?: ChangedFile
}
interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: ChangedFile
  readonly nameIndex?: number
}
const fileTreeRows = (
  files: ReadonlyArray<ChangedFile>,
  innerWidth: number,
  showCounts: boolean,
  _accent: ColorInput,
): ReadonlyArray<ChangedFileRow> => {
  if (files.length === 0) return [{ chunks: [fg(colors.muted)("No changes")] }]
  const root: ChangedNode = { children: new Map() }
  for (const file of [...files].toSorted((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/")
    let node = root
    segments.forEach((segment, index) => {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }
      if (index === segments.length - 1) child.file = file
      node = child
    })
  }
  const rows: Array<ChangedFileRow> = []
  const walk = (node: ChangedNode, depth: number): void => {
    for (const [name, child] of node.children) {
      const indent = "  ".repeat(depth)
      const displayName = escapeControlCharacters(name)
      const indentChunks = indent.length > 0 ? [fg(colors.text)(indent)] : []
      if (child.file === undefined) {
        rows.push({
          chunks: [
            ...indentChunks,
            dim(fg(colors.text)(truncateToWidth(`${displayName}/`, Math.max(1, innerWidth - indent.length)))),
          ],
        })
        walk(child, depth + 1)
      } else {
        const hasCounts = child.file.added !== undefined || child.file.removed !== undefined
        const added = ` +${child.file.added ?? 0}`
        const removed = ` -${child.file.removed ?? 0}`
        const label = truncateToWidth(
          displayName,
          Math.max(
            1,
            innerWidth - indent.length - (showCounts && hasCounts ? stringWidth(added) + stringWidth(removed) : 0),
          ),
        )
        rows.push({
          chunks: [
            ...indentChunks,
            fg(colors.text)(label),
            ...(showCounts && hasCounts ? [dim(fg(colors.green)(added)), dim(fg(colors.red)(removed))] : []),
          ],
          file: child.file,
          nameIndex: indentChunks.length,
        })
      }
    }
  }
  walk(root, 0)
  return rows
}
export const sidebarInnerWidth = (model: Model): number => Math.max(1, fileSidebarLayoutWidth(model) - 8)
const sidebarFileRowsImpl = (model: Model, innerWidth: number): ReadonlyArray<ChangedFileRow> =>
  model.changedFilesOpen
    ? fileTreeRows(
        model.changedFiles._tag === "Ready" ? model.changedFiles.value : [],
        innerWidth,
        true,
        colors[model.mode],
      )
    : fileTreeRows(
        model.filePicker.items._tag === "Ready"
          ? model.filePicker.items.value.map((path) => ({ path, status: "" }))
          : [],
        innerWidth,
        false,
        colors[model.mode],
      )

export const sidebarFileRows: {
  (
    arg1: Parameters<typeof sidebarFileRowsImpl>[1],
  ): (arg0: Parameters<typeof sidebarFileRowsImpl>[0]) => ReturnType<typeof sidebarFileRowsImpl>
  (
    arg0: Parameters<typeof sidebarFileRowsImpl>[0],
    arg1: Parameters<typeof sidebarFileRowsImpl>[1],
  ): ReturnType<typeof sidebarFileRowsImpl>
} = Function.dual(2, sidebarFileRowsImpl)
const renderFileRowsImpl = (rows: ReadonlyArray<ChangedFileRow>, hoveredRow?: number): StyledText => {
  const chunks: Array<TextChunk> = []
  for (const [index, row] of rows.entries()) {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if (index === hoveredRow && row.file !== undefined && row.nameIndex !== undefined)
      chunks.push(...row.chunks.map((chunk, i) => (i === row.nameIndex ? underline(chunk) : chunk)))
    else chunks.push(...row.chunks)
  }
  return new StyledText(chunks.map(toOpenStyledChunk))
}

export const renderFileRows: {
  (
    arg0: Parameters<typeof renderFileRowsImpl>[0],
    arg1?: Parameters<typeof renderFileRowsImpl>[1],
  ): ReturnType<typeof renderFileRowsImpl>
  (
    arg1?: Parameters<typeof renderFileRowsImpl>[1],
  ): (arg0: Parameters<typeof renderFileRowsImpl>[0]) => ReturnType<typeof renderFileRowsImpl>
} = Function.dual((args) => Array.isArray(args[0]), renderFileRowsImpl)
export const renderChangedFiles: {
  (model: Model, innerWidth: number, hoveredRow?: number): StyledText
  (innerWidth: number, hoveredRow?: number): (model: Model) => StyledText
} = Function.dual(
  (args) => args.length > 1 && typeof args[0] !== "number",
  (model: Model, innerWidth: number, hoveredRow?: number) =>
    renderFileRows(
      fileTreeRows(
        model.changedFiles._tag === "Ready" ? model.changedFiles.value : [],
        innerWidth,
        true,
        colors[model.mode],
      ),
      hoveredRow,
    ),
)
