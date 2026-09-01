import { bold, dim, fg, italic, strikethrough, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { colors } from "../../../presentation/terminal/theme"
import type { ToolSummary } from "../../../presentation/transcript/tool/detail-types"
import { renderToolSummary } from "../diff-text-adapter"
import { highlightShellCommand, wrapStyledLine } from "../text-adapter"
import { shellCommandText, shellExitCode, type ToolUnit } from "../tool/detail"
import { wrapTextToWidth, type RowStatus } from "../window"

type DetailContent = {
  readonly append: (chunk: TextChunk) => void
  readonly statusIcon: (status: RowStatus) => TextChunk
}

type ToolBlock = ToolUnit["block"]

const renderCancelledShellHeader = (
  content: DetailContent,
  block: ToolBlock,
  label: string,
  rowWidth: number,
  branchPrefix: string,
  continuationPrefix: string,
) => {
  const command = label.startsWith("$ ") ? label.slice(2) : label
  content.append(content.statusIcon(block.status))
  content.append(fg(colors.text)(" "))
  content.append(bold(fg(colors.gold)("$ ")))
  const suffix = " (cancelled)"
  const commandWidth = Math.max(1, rowWidth - stringWidth(branchPrefix) - 2 - stringWidth(suffix))
  for (const [rowIndex, row] of wrapTextToWidth(command, commandWidth).entries()) {
    if (rowIndex > 0) {
      content.append(fg(colors.text)("\n"))
      content.append(dim(fg(colors.subtle)(continuationPrefix)))
    }
    content.append(strikethrough(fg(colors.text)(row)))
  }
  content.append(italic(fg(colors.amber)(suffix)))
}

const renderShellHeader = (
  content: DetailContent,
  block: ToolBlock,
  rowWidth: number,
  branchPrefix: string,
  continuationPrefix: string,
) => {
  const failure = block.status === "failed" ? ` (exit code: ${shellExitCode(block) ?? 1})` : ""
  const commandWidth = Math.max(1, rowWidth - stringWidth(branchPrefix) - 4 - stringWidth(failure))
  content.append(fg(colors.text)(" "))
  content.append(bold(fg(colors.gold)("$ ")))
  const rows = shellCommandText(block)
    .split("\n")
    .flatMap((current) => wrapStyledLine(highlightShellCommand(current)[0] ?? [], commandWidth))
  for (const [rowIndex, row] of rows.entries()) {
    if (rowIndex > 0) {
      content.append(fg(colors.text)("\n"))
      content.append(dim(fg(colors.subtle)(continuationPrefix)))
    }
    for (const chunk of row) content.append(chunk)
  }
  if (failure.length > 0) content.append(fg(colors.red)(failure))
}

const renderSummaryHeader = (
  content: DetailContent,
  summary: ReadonlyArray<ReadonlyArray<TextChunk>>,
  prefix: string,
) => {
  for (const [lineIndex, line] of summary.entries()) {
    if (lineIndex > 0) {
      content.append(fg(colors.text)("\n"))
      content.append(dim(fg(colors.subtle)(prefix)))
    } else content.append(fg(colors.text)(" "))
    for (const chunk of line) content.append(chunk)
  }
}

const renderActiveToolHeader = (
  content: DetailContent,
  block: ToolBlock,
  summary: ToolSummary,
  rowWidth: number,
  branchPrefix: string,
  continuationPrefix: string,
  shellContinuationPrefix: string,
  underlineSecondary: boolean,
) => {
  content.append(content.statusIcon(block.status))
  if (block.presentation.family === "shell")
    renderShellHeader(content, block, rowWidth, branchPrefix, shellContinuationPrefix)
  else
    renderSummaryHeader(
      content,
      renderToolSummary(summary, {
        width: rowWidth - stringWidth(continuationPrefix),
        underlineSecondary,
      }),
      continuationPrefix,
    )
}

const renderToolHeader = (
  content: DetailContent,
  block: ToolBlock,
  label: string,
  summary: ToolSummary,
  rowWidth: number,
  branchPrefix: string,
  continuationPrefix: string,
  shellContinuationPrefix: string,
  underlineSecondary = false,
) => {
  if (block.status === "cancelled" && block.presentation.family === "shell")
    renderCancelledShellHeader(content, block, label, rowWidth, branchPrefix, shellContinuationPrefix)
  else
    renderActiveToolHeader(
      content,
      block,
      summary,
      rowWidth,
      branchPrefix,
      continuationPrefix,
      shellContinuationPrefix,
      underlineSecondary,
    )
}

const renderExpandedToolOutput = (
  content: Pick<DetailContent, "append">,
  output: string,
  rowWidth: number,
  outputIndent: string,
) => {
  const outputWidth = Math.max(1, rowWidth - stringWidth(outputIndent))
  const renderedOutput = wrapTextToWidth(output, outputWidth).join(`\n${outputIndent}`)
  content.append(fg(colors.text)("\n"))
  content.append(dim(fg(colors.subtle)(outputIndent)))
  content.append(dim(fg(colors.text)(renderedOutput)))
}

export const detailContent = {
  renderExpandedToolOutput,
  renderToolHeader,
}
