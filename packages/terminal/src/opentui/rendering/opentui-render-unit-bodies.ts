import { bold, dim, fg, type StyledText, type TextChunk } from "@opentui/core"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import type { TranscriptBlock } from "../../state/model/terminal-transcript-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { renderDiffStyled, renderPierreDiff, renderToolSummary } from "./terminal-diff-text-adapter"
import { isToolOutputDisplayed } from "../../presentation/transcript/transcript-agent-response"
import { agentToolSummary } from "../../presentation/transcript/transcript-tool-detail"
import { wrapBodyText } from "./opentui-render-window"
import { diffCounts } from "./opentui-render-tool-detail"
import { renderBlock } from "./opentui-render-block"
import type { TerminalTextChunk } from "../../presentation/markdown/styled-text"

type Append = (chunk: TextChunk | TerminalTextChunk) => void
type AppendAll = (styled: StyledText) => void

export const toolOutputDisplayed = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): boolean =>
  isToolOutputDisplayed(block)

export const renderDiffBody = (
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

export const renderChildAgentBody = (
  block: Extract<TranscriptBlock, { _tag: "ChildAgent" }>,
  expanded: boolean,
  width: number,
  statusIcon: (failed: boolean, running: boolean, cancelled?: boolean) => TextChunk,
  marker: (expanded: boolean) => TextChunk,
  append: Append,
): void => {
  const running = block.status === "running"
  const phrase = TranscriptProjection.Presentation.agentPhrase({ name: block.name, status: block.status })
  append(statusIcon(block.status === "failed", running, block.status === "cancelled"))
  for (const chunk of renderToolSummary(agentToolSummary(phrase), { leading: " " })[0]!) append(chunk)
  append(marker(expanded))
  if (expanded) {
    if (block.summary.length > 0) append(dim(fg(colors.text)(`\n${wrapBodyText(block.summary, width, "  ")}`)))
    for (const activity of block.activity) append(dim(fg(colors.text)(`\n${wrapBodyText(activity, width, "  ")}`)))
  }
}

export const renderPlainBody = (block: TranscriptBlock, width: number, append: Append): void => {
  let color = colors.text
  if (block._tag === "ContextUsage") color = colors.muted
  else if (block._tag === "Error") color = colors.red
  append(fg(color)(renderBlock(block, width)))
}
