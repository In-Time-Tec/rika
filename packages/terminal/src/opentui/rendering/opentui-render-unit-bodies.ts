import { Function } from "effect"
import { bold, dim, fg, type StyledText, type TextChunk } from "@opentui/core"
import { cellGlyph, cellOutputTruncated, formatCellDuration } from "@rika/transcript/cell-presentation"
import { highlightLines } from "../../presentation/markdown/syntax-highlighter"
import { wrapBodyText } from "./opentui-render-window"
import type { TranscriptBlock } from "../../state/model/terminal-transcript-state"
import type { Model } from "../../state/model/terminal-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { renderDiffStyled, renderPierreDiff } from "./terminal-diff-text-adapter"
import { isToolOutputDisplayed } from "../../presentation/transcript/transcript-agent-response"
import { diffCounts } from "./opentui-render-tool-detail"
import { completedCompactionIcon, renderBlock } from "./opentui-render-block"
import type { TerminalTextChunk } from "../../presentation/markdown/styled-text"
import { toOpenChunk, wrapStyledLine } from "./terminal-text-adapter"

type Append = (chunk: TextChunk | TerminalTextChunk) => void
type AppendAll = (styled: StyledText) => void

export const toolOutputDisplayed = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): boolean =>
  isToolOutputDisplayed(block)

const renderDiffBodyImpl = (
  block: Extract<TranscriptBlock, { _tag: "Diff" }>,
  selected: boolean,
  expanded: boolean,
  width: number,
  append: Append,
  appendAll: AppendAll,
): void => {
  if (expanded) {
    append(bold(fg(selected ? colors.blue : colors.muted)(`Δ ${block.path} ▾\n`)))
    appendAll(renderPierreDiff(block.patch, { width }) ?? renderDiffStyled(block.patch, { width }))
    return
  }
  const [added, removed] = diffCounts(block.patch)
  const verb = /^--- \/dev\/null$/m.test(block.patch) || /^new file mode /m.test(block.patch) ? "Created" : "Edited"
  if (selected) append(bold(fg(colors.blue)(`✓ ${verb} ${block.path} +${added} -${removed} ▸`)))
  else {
    append(fg(colors.green)("✓"))
    append(fg(colors.text)(` ${verb} ${block.path}`))
    append(fg(colors.green)(` +${added}`))
    append(fg(colors.red)(` -${removed}`))
    append(fg(colors.subtle)(" ▸"))
  }
}

export const renderDiffBody: {
  (
    arg1: Parameters<typeof renderDiffBodyImpl>[1],
    arg2: Parameters<typeof renderDiffBodyImpl>[2],
    arg3: Parameters<typeof renderDiffBodyImpl>[3],
    arg4: Parameters<typeof renderDiffBodyImpl>[4],
    arg5: Parameters<typeof renderDiffBodyImpl>[5],
  ): (arg0: Parameters<typeof renderDiffBodyImpl>[0]) => ReturnType<typeof renderDiffBodyImpl>
  (
    arg0: Parameters<typeof renderDiffBodyImpl>[0],
    arg1: Parameters<typeof renderDiffBodyImpl>[1],
    arg2: Parameters<typeof renderDiffBodyImpl>[2],
    arg3: Parameters<typeof renderDiffBodyImpl>[3],
    arg4: Parameters<typeof renderDiffBodyImpl>[4],
    arg5: Parameters<typeof renderDiffBodyImpl>[5],
  ): ReturnType<typeof renderDiffBodyImpl>
} = Function.dual(6, renderDiffBodyImpl)

const cellStatusColor = (status: Extract<TranscriptBlock, { _tag: "Cell" }>["status"]) => {
  if (status === "running") return colors.blue
  if (status === "complete") return colors.green
  if (status === "cancelled") return colors.amber
  return colors.red
}

const renderCellBodyImpl = (
  block: Extract<TranscriptBlock, { _tag: "Cell" }>,
  selected: boolean,
  expanded: boolean,
  width: number,
  spinnerFrame: string,
  append: Append,
): void => {
  const running = block.status === "running"
  let icon = "✕"
  if (running) icon = spinnerFrame
  else if (block.status === "complete") icon = "✓"
  else if (block.status === "cancelled") icon = "⊘"
  else if (block.status === "unknown") icon = "?"
  const header: Array<TextChunk> = [
    fg(cellStatusColor(block.status))(`${icon} `),
    fg(colors.subtle)(cellGlyph(block.visual)),
  ]
  if (block.summary.length > 0) {
    header.push(fg(colors.text)(" "))
    header.push(...highlightLines(block.summary, "typescript")[0]!.map(toOpenChunk))
  }
  const duration = block.durationMillis === undefined ? "" : formatCellDuration(block.durationMillis)
  if (duration.length > 0) header.push(fg(colors.subtle)(" "), fg(colors.subtle)(duration))
  if (cellOutputTruncated(block)) header.push(fg(colors.subtle)(" "), fg(colors.amber)("truncated"))
  header.push(fg(colors.subtle)(expanded ? " ▾" : " ▸"))
  for (const [rowIndex, row] of wrapStyledLine(header, Math.max(1, width - 2)).entries()) {
    if (rowIndex > 0) append(fg(colors.text)("\n  "))
    for (const chunk of row) append(selected ? bold(chunk) : chunk)
  }
  if (!expanded) return
  const source = highlightLines(block.source.text, "typescript")
  const summaryLine = source.findIndex(
    (line) =>
      line
        .map((chunk) => chunk.text)
        .join("")
        .trim() === block.summary.trim(),
  )
  for (const [lineIndex, line] of source.entries()) {
    if (lineIndex === summaryLine) continue
    for (const row of wrapStyledLine(line.map(toOpenChunk), Math.max(1, width - 2))) {
      append(fg(colors.text)("\n  "))
      for (const chunk of row) append(chunk)
    }
  }
  if (block.source.truncated) append(dim(fg(colors.amber)("\n  Source truncated.")))
  if (block.output.stdout.length > 0)
    append(dim(fg(colors.text)(`\n${wrapBodyText(block.output.stdout, width, "  ")}`)))
  if (block.output.stderr.length > 0) append(dim(fg(colors.red)(`\n${wrapBodyText(block.output.stderr, width, "  ")}`)))
  if (block.result !== undefined && block.result.length > 0)
    append(fg(colors.text)(`\n${wrapBodyText(block.result, width, "  ")}`))
  if (block.error !== undefined) {
    append(fg(colors.red)(`\n${wrapBodyText(`${block.error.name}: ${block.error.message}`, width, "  ")}`))
    if (block.error.stack !== undefined && block.error.stack.length > 0)
      append(dim(fg(colors.red)(`\n${wrapBodyText(block.error.stack, width, "  ")}`)))
  }
  for (const notice of block.notices) append(dim(fg(colors.amber)(`\n${wrapBodyText(notice.detail, width, "  ")}`)))
  if (block.output.droppedBytes > 0 || block.output.droppedEvents > 0)
    append(
      dim(
        fg(colors.amber)(
          `\n  Dropped ${block.output.droppedBytes} bytes and ${block.output.droppedEvents} events at the output bound.`,
        ),
      ),
    )
}

export const renderCellBody: {
  (
    arg1: Parameters<typeof renderCellBodyImpl>[1],
    arg2: Parameters<typeof renderCellBodyImpl>[2],
    arg3: Parameters<typeof renderCellBodyImpl>[3],
    arg4: Parameters<typeof renderCellBodyImpl>[4],
    arg5: Parameters<typeof renderCellBodyImpl>[5],
  ): (arg0: Parameters<typeof renderCellBodyImpl>[0]) => ReturnType<typeof renderCellBodyImpl>
  (
    arg0: Parameters<typeof renderCellBodyImpl>[0],
    arg1: Parameters<typeof renderCellBodyImpl>[1],
    arg2: Parameters<typeof renderCellBodyImpl>[2],
    arg3: Parameters<typeof renderCellBodyImpl>[3],
    arg4: Parameters<typeof renderCellBodyImpl>[4],
    arg5: Parameters<typeof renderCellBodyImpl>[5],
  ): ReturnType<typeof renderCellBodyImpl>
} = Function.dual(6, renderCellBodyImpl)

const compactionRainbow = ["#ff5f6d", "#ff9f43", "#ffd166", "#7bd389", "#5bc0eb", "#8c7ae6", "#d980fa"] as const

const renderPlainBodyImpl = (model: Model, block: TranscriptBlock, width: number, append: Append): void => {
  if (block._tag === "Compaction" && block.status === "complete") {
    const phase = model.compactionShimmer?.tick ?? 0
    for (const [index, character] of Array.from(`${completedCompactionIcon} Auto-compacted`).entries())
      append(fg(compactionRainbow[(index + phase) % compactionRainbow.length]!)(character))
    return
  }
  let color = colors.text
  if (block._tag === "ContextUsage") color = colors.muted
  else if (block._tag === "Error") {
    const rendered = renderBlock(block, width)
    const lineBreak = rendered.indexOf("\n")
    if (lineBreak < 0) append(bold(fg(colors.red)(rendered)))
    else {
      append(bold(fg(colors.red)(rendered.slice(0, lineBreak))))
      append(fg(colors.red)(rendered.slice(lineBreak)))
    }
    return
  }
  append(fg(color)(renderBlock(block, width)))
}

export const renderPlainBody: {
  (
    arg1: Parameters<typeof renderPlainBodyImpl>[1],
    arg2: Parameters<typeof renderPlainBodyImpl>[2],
    arg3: Parameters<typeof renderPlainBodyImpl>[3],
  ): (arg0: Parameters<typeof renderPlainBodyImpl>[0]) => ReturnType<typeof renderPlainBodyImpl>
  (
    arg0: Parameters<typeof renderPlainBodyImpl>[0],
    arg1: Parameters<typeof renderPlainBodyImpl>[1],
    arg2: Parameters<typeof renderPlainBodyImpl>[2],
    arg3: Parameters<typeof renderPlainBodyImpl>[3],
  ): ReturnType<typeof renderPlainBodyImpl>
} = Function.dual(4, renderPlainBodyImpl)
