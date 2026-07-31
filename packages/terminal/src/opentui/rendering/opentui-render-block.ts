import type { ColorInput, TextChunk } from "@opentui/core"
import { Function, Option, Schema } from "effect"
import stringWidth from "string-width"
import type { TranscriptBlock } from "../../state/model/terminal-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { escapeControlCharacters, formatBytes, truncateToWidth } from "../../presentation/terminal/terminal-format"
import { renderDiff } from "../../presentation/tool/diff-renderer"
import { fg, dim, bg, underline, StyledText } from "@opentui/core"
import { boundedThreadSidebarWidth, fileSidebarLayoutWidth } from "../../state/model/terminal-state"
import type { ThreadItem } from "../../state/model/terminal-state"
import { isThreadBusy } from "../../state/model/terminal-state"
import { toOpenColor } from "./terminal-text-adapter"

const idleSpinnerFrame = "⠭"
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
const ToolInputJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const toolInputValue = (input: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(ToolInputJson)(input), () => ({}))
const inputString = (value: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
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
        return `✓ Auto-compacted context${block.checkpoint === undefined ? "" : ` at ${block.checkpoint}`}${block.summary.length === 0 ? "" : `\n${body(block.summary)}`}`
      case "Notification":
        return `${head(`! ${block.title}`)}\n${body(block.detail)}`
      case "Error":
        return `${head(`✖ ERROR: ${block.title}${block.turnId === undefined ? "" : ` · Turn ${block.turnId}`}`)}\n${body(block.detail)}${block.recovery === undefined ? "" : `\n${body(`Next: ${block.recovery}`)}`}`
      case "ChildAgent": {
        let icon = "✗"
        if (block.status === "running") icon = "⠿"
        else if (block.status === "complete") icon = "✓"
        else if (block.status === "cancelled") icon = "⊘"
        let status = "finished"
        if (block.status === "running") status = "working"
        else if (block.status === "cancelled") status = "cancelled"
        return `${icon} Subagent ${status} ▸\n${body(`${block.name} · ${block.summary}`)}`
      }
      case "Workflow":
        return `◫ Workflow ${block.name} [${block.status}]\n${body(block.step)}`
      case "ImageAttachment": {
        const dimensions =
          block.width !== undefined && block.height !== undefined ? ` · ${block.width}×${block.height}` : ""
        const size = block.bytes === undefined ? "" : ` · ${formatBytes(block.bytes)}`
        return `▧ ${block.name} · ${block.mediaType}${dimensions}${size}`
      }
    }
  },
)

export const renderSidebar: {
  (spinnerFrame?: string): (model: import("../../state/model/terminal-state").Model) => StyledText
  (model: import("../../state/model/terminal-state").Model): StyledText
  (model: import("../../state/model/terminal-state").Model, spinnerFrame?: string): StyledText
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
        const selected = model.threadSidebar.focused && index === model.threadSidebar.selected
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

const changedFileColor = (status: string): ColorInput => {
  if (status.includes("?")) return colors.muted
  if (status.includes("A")) return colors.green
  if (status.includes("D")) return colors.red
  if (status.includes("R")) return colors.purple
  if (status.includes("M")) return colors.amber
  return colors.text
}
interface ChangedNode {
  readonly children: Map<string, ChangedNode>
  file?: import("../../state/model/terminal-state").ChangedFile
}
interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: import("../../state/model/terminal-state").ChangedFile
  readonly nameIndex?: number
}
const fileTreeRows = (
  files: ReadonlyArray<import("../../state/model/terminal-state").ChangedFile>,
  innerWidth: number,
  showCounts: boolean,
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
            fg(colors.muted)(truncateToWidth(`${displayName}/`, Math.max(1, innerWidth - indent.length))),
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
            fg(changedFileColor(child.file.status))(label),
            ...(showCounts && hasCounts ? [fg(colors.green)(added), fg(colors.red)(removed)] : []),
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
export const sidebarInnerWidth = (model: import("../../state/model/terminal-state").Model): number =>
  Math.max(1, fileSidebarLayoutWidth(model) - 8)
export const sidebarFileRows = (
  model: import("../../state/model/terminal-state").Model,
  innerWidth: number,
): ReadonlyArray<ChangedFileRow> =>
  model.changedFilesOpen
    ? fileTreeRows(model.changedFiles._tag === "Ready" ? model.changedFiles.value : [], innerWidth, true)
    : fileTreeRows(
        model.filePicker.items._tag === "Ready"
          ? model.filePicker.items.value.map((path) => ({ path, status: "" }))
          : [],
        innerWidth,
        false,
      )
export const renderFileRows = (rows: ReadonlyArray<ChangedFileRow>, hoveredRow?: number): StyledText => {
  const chunks: Array<TextChunk> = []
  for (const [index, row] of rows.entries()) {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if (index === hoveredRow && row.file !== undefined && row.nameIndex !== undefined)
      chunks.push(...row.chunks.map((chunk, i) => (i === row.nameIndex ? underline(chunk) : chunk)))
    else chunks.push(...row.chunks)
  }
  return new StyledText(chunks.map(toOpenStyledChunk))
}
export const renderChangedFiles: {
  (model: import("../../state/model/terminal-state").Model, innerWidth: number, hoveredRow?: number): StyledText
  (innerWidth: number, hoveredRow?: number): (model: import("../../state/model/terminal-state").Model) => StyledText
} = Function.dual(
  (args) => args.length > 1 && typeof args[0] !== "number",
  (model, innerWidth, hoveredRow) =>
    renderFileRows(
      fileTreeRows(model.changedFiles._tag === "Ready" ? model.changedFiles.value : [], innerWidth, true),
      hoveredRow,
    ),
)

export { iconChar, toolInputValue, inputString }
