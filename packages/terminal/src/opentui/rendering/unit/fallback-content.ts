import { dim, fg, type TextChunk } from "@opentui/core"
import { colors } from "../../../presentation/terminal/theme"
import { toolResultText } from "../../../presentation/transcript/tool/body"
import { toolDetail } from "../../../presentation/transcript/tool/detail"
import { cancelledAgentLabel, failedAgentLabel, iconChar, wrapBodyText } from "../window"
import { renderToolSummary } from "../diff-text-adapter"
import { renderMarkdownLines } from "../text-adapter"
import { shellExitCode, type ToolUnit } from "../tool/detail"
import { toolOutputDisplayed } from "./bodies"

type FallbackContent = {
  readonly append: (chunk: TextChunk) => void
  readonly highlight: (text: string) => void
  readonly renderAgentPrompt: (text: string, prefix: string) => void
  readonly statusIcon: (failed: boolean, running: boolean, cancelled?: boolean) => TextChunk
  readonly width: number
  readonly spinnerFrame: string
}

const displayedLabel = (unit: ToolUnit): string => {
  if (unit.block.status === "running") return unit.block.presentation.activeLabel
  if (unit.block.presentation.family !== "agent") return unit.block.presentation.completeLabel
  if (unit.block.status === "cancelled") return cancelledAgentLabel(unit.block.presentation.activeLabel)
  if (unit.block.status === "failed") return failedAgentLabel(unit.block.presentation.activeLabel)
  return unit.block.presentation.completeLabel
}

const failureSuffix = (unit: ToolUnit): string =>
  unit.block.status === "failed" && unit.block.presentation.family === "shell"
    ? ` (exit code: ${shellExitCode(unit.block) ?? 1})`
    : ""

const renderSummary = (content: FallbackContent, unit: ToolUnit, label: string, failure: string) => {
  content.append(
    content.statusIcon(
      unit.block.status === "failed",
      unit.block.status === "running",
      unit.block.status === "cancelled",
    ),
  )
  const summary = toolDetail(unit.index, {
    ...unit.block,
    presentation: { ...unit.block.presentation, activeLabel: label, completeLabel: label },
  }).summary
  for (const chunk of renderToolSummary(summary, { leading: " " })[0]!) content.append(chunk)
  if (failure.length > 0) content.append(fg(colors.red)(failure))
}

const renderWebOutput = (content: FallbackContent, output: string) => {
  const rows = renderMarkdownLines(output.trimEnd(), Math.max(1, content.width - 2))
  for (const [rowIndex, row] of rows.entries()) {
    content.append(dim(fg(colors.text)("  ")))
    for (const chunk of row) content.append(chunk)
    if (rowIndex < rows.length - 1) content.append(fg(colors.text)("\n"))
  }
}

const renderOutput = (content: FallbackContent, unit: ToolUnit, output: string) => {
  content.append(fg(colors.text)("\n"))
  if (unit.block.presentation.action === "read-web-page") renderWebOutput(content, output)
  else content.append(dim(fg(colors.text)(wrapBodyText(output, content.width, "  "))))
}

const renderFallbackToolBody = (content: FallbackContent, unit: ToolUnit, selected: boolean, expanded: boolean) => {
  const failed = unit.block.status === "failed"
  const running = unit.block.status === "running"
  const cancelled = unit.block.status === "cancelled"
  const label = displayedLabel(unit)
  const agent = unit.block.presentation.family === "agent"
  const detail = unit.block.detail.length === 0 ? "" : ` ${unit.block.detail}`
  const failure = failureSuffix(unit)
  if (selected)
    content.highlight(
      `${iconChar(failed, running, content.spinnerFrame, cancelled)} ${label}${agent ? "" : detail}${failure}`,
    )
  else renderSummary(content, unit, label, failure)
  if (!expanded) return
  if (agent && unit.block.detail.length > 0) content.renderAgentPrompt(unit.block.detail, "  ")
  else if (!agent && toolOutputDisplayed(unit.block)) {
    const output = toolResultText(unit.block.result)
    if (output !== undefined) renderOutput(content, unit, output)
  }
}

export const fallbackContent = { renderToolBody: renderFallbackToolBody }
