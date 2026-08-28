import { Function, Schema } from "effect"
import { bold, dim, fg, type StyledText, type TextChunk } from "@opentui/core"
import { cellOutputTruncated, formatCellDuration, formatCellResult } from "@rika/transcript/cell-presentation"
import { highlightLines } from "../../../presentation/markdown/syntax-highlighter"
import { wrapBodyText } from "../window"
import type { TranscriptBlock } from "../../../state/transcript/model"
import type { Model } from "../../../state/model"
import { colors } from "../../../presentation/terminal/theme"
import { renderDiffStyled, renderPierreDiff } from "../diff-text-adapter"
import { isToolOutputDisplayed } from "../../../presentation/transcript/agent-response"
import { diffCounts } from "../tool/detail"
import { completedCompactionIcon, renderBlock } from "../block"
import type { TerminalTextChunk } from "../../../presentation/markdown/styled-text"
import { toOpenChunk, wrapStyledLine } from "../text-adapter"
import type { UnitLineRange } from "../transcript/window"

type Append = (chunk: TextChunk | TerminalTextChunk) => void
type AppendAll = (styled: StyledText) => void
interface CellRenderContext {
  readonly nestedRanges: Array<UnitLineRange>
  readonly rowExpanded: (id: string) => boolean
  readonly line: () => number
}

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

const collapsedCellLines = 15
const HostCallPath = Schema.fromJsonString(Schema.Struct({ path: Schema.String }))

const hostCallLabel = (operation: string, inputSummary: string): string => {
  const action = operation.length === 0 ? "Call" : `${operation[0]!.toUpperCase()}${operation.slice(1)}`
  const input = Schema.decodeOption(HostCallPath)(inputSummary)
  return input._tag === "Some" ? `${action} ${input.value.path}` : action
}

const renderCellBodyImpl = (
  block: Extract<TranscriptBlock, { _tag: "Cell" }>,
  selected: boolean,
  expanded: boolean,
  width: number,
  spinnerFrame: string,
  append: Append,
  context?: CellRenderContext,
): void => {
  const running = block.status === "running"
  let icon = "✕"
  if (running) icon = spinnerFrame
  else if (block.status === "complete") icon = "✓"
  else if (block.status === "cancelled") icon = "⊘"
  else if (block.status === "unknown") icon = "?"
  const header: Array<TextChunk> = [fg(cellStatusColor(block.status))(icon)]
  if (block.visual === "shell") header.push(fg(colors.subtle)(" $"))
  for (const chunk of header) append(selected ? bold(chunk) : chunk)
  const source = highlightLines(block.source.text, "typescript")
  const visibleSource = expanded ? source : source.slice(0, collapsedCellLines)
  for (const line of visibleSource) {
    for (const row of wrapStyledLine(line.map(toOpenChunk), Math.max(1, width - 2))) {
      append(fg(colors.text)("\n  "))
      for (const chunk of row) append(chunk)
    }
  }
  const hiddenLines = Math.max(0, source.length - visibleSource.length)
  const footer: Array<string> = []
  if (hiddenLines > 0) footer.push(`… ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}`)
  const duration = block.durationMillis === undefined ? "" : formatCellDuration(block.durationMillis)
  if (duration.length > 0) footer.push(duration)
  if (cellOutputTruncated(block)) footer.push("truncated")
  if (block.calls.length > 0) footer.push(`${block.calls.length} ${block.calls.length === 1 ? "call" : "calls"}`)
  footer.push(expanded ? "▾" : "▸")
  append(dim(fg(colors.subtle)(`\n  ${footer.join(" · ")}`)))
  if (!expanded) return
  if (block.source.truncated) append(dim(fg(colors.amber)("\n  Source truncated.")))
  if (block.output.stdout.length > 0)
    append(dim(fg(colors.text)(`\n  stdout\n${wrapBodyText(block.output.stdout, width, "    ")}`)))
  if (block.output.stderr.length > 0)
    append(dim(fg(colors.red)(`\n  stderr\n${wrapBodyText(block.output.stderr, width, "    ")}`)))
  if (block.result !== undefined)
    append(fg(colors.text)(`\n  result\n${wrapBodyText(formatCellResult(block.result), width, "    ")}`))
  if (block.error !== undefined) {
    append(fg(colors.red)(`\n  error\n${wrapBodyText(`${block.error.name}: ${block.error.message}`, width, "    ")}`))
    if (block.error.stack !== undefined && block.error.stack.length > 0) {
      const id = `cell-stack:${block.id}`
      const start = context?.line() ?? 0
      const shown = context?.rowExpanded(id) ?? false
      append(dim(fg(colors.subtle)(`\n    stack ${shown ? "▾" : "▸"}`)))
      const headerEnd = context?.line() ?? start
      if (shown) append(dim(fg(colors.red)(`\n${wrapBodyText(block.error.stack, width, "      ")}`)))
      context?.nestedRanges.push({ start, end: context.line(), headerEnd, unit: id, expandable: true })
    }
  }
  for (const call of block.calls) {
    const id = `cell-call:${block.id}:${call.id}`
    const start = context?.line() ?? 0
    const shown = context?.rowExpanded(id) ?? false
    let callIcon = "✓"
    if (call.status === "started") callIcon = spinnerFrame
    else if (call.status === "failed") callIcon = "✕"
    const callDuration = call.durationMillis === undefined ? "" : ` · ${formatCellDuration(call.durationMillis)}`
    append(
      fg(call.status === "failed" ? colors.red : colors.text)(
        `\n  ${callIcon} ${hostCallLabel(call.operation, call.inputSummary)}${callDuration} ${shown ? "▾" : "▸"}`,
      ),
    )
    const headerEnd = context?.line() ?? start
    if (shown) {
      append(dim(fg(colors.text)(`\n${wrapBodyText(call.inputSummary, width, "    ")}`)))
      if (call.message !== undefined) append(dim(fg(colors.text)(`\n${wrapBodyText(call.message, width, "    ")}`)))
    }
    context?.nestedRanges.push({ start, end: context.line(), headerEnd, unit: id, expandable: true })
  }
  for (const notice of block.notices) append(dim(fg(colors.amber)(`\n${wrapBodyText(notice.detail, width, "  ")}`)))
}

export const renderCellBody: {
  (
    arg1: Parameters<typeof renderCellBodyImpl>[1],
    arg2: Parameters<typeof renderCellBodyImpl>[2],
    arg3: Parameters<typeof renderCellBodyImpl>[3],
    arg4: Parameters<typeof renderCellBodyImpl>[4],
    arg5: Parameters<typeof renderCellBodyImpl>[5],
    arg6?: Parameters<typeof renderCellBodyImpl>[6],
  ): (arg0: Parameters<typeof renderCellBodyImpl>[0]) => ReturnType<typeof renderCellBodyImpl>
  (
    arg0: Parameters<typeof renderCellBodyImpl>[0],
    arg1: Parameters<typeof renderCellBodyImpl>[1],
    arg2: Parameters<typeof renderCellBodyImpl>[2],
    arg3: Parameters<typeof renderCellBodyImpl>[3],
    arg4: Parameters<typeof renderCellBodyImpl>[4],
    arg5: Parameters<typeof renderCellBodyImpl>[5],
    arg6?: Parameters<typeof renderCellBodyImpl>[6],
  ): ReturnType<typeof renderCellBodyImpl>
} = Function.dual((args) => args.length >= 6, renderCellBodyImpl)

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
