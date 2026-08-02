import { Function } from "effect"
import { bold, dim, fg, type StyledText, type TextChunk } from "@opentui/core"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import type { TranscriptBlock } from "../../state/model/terminal-transcript-state"
import type { Model } from "../../state/model/terminal-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { renderDiffStyled, renderPierreDiff, renderToolSummary } from "./terminal-diff-text-adapter"
import { isToolOutputDisplayed } from "../../presentation/transcript/transcript-agent-response"
import { agentToolSummary } from "../../presentation/transcript/transcript-tool-detail"
import { wrapBodyText } from "./opentui-render-window"
import { diffCounts } from "./opentui-render-tool-detail"
import { completedCompactionIcon, renderBlock } from "./opentui-render-block"
import type { TerminalTextChunk } from "../../presentation/markdown/styled-text"

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

const renderChildAgentBodyImpl = (
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

export const renderChildAgentBody: {
  (
    arg1: Parameters<typeof renderChildAgentBodyImpl>[1],
    arg2: Parameters<typeof renderChildAgentBodyImpl>[2],
    arg3: Parameters<typeof renderChildAgentBodyImpl>[3],
    arg4: Parameters<typeof renderChildAgentBodyImpl>[4],
    arg5: Parameters<typeof renderChildAgentBodyImpl>[5],
  ): (arg0: Parameters<typeof renderChildAgentBodyImpl>[0]) => ReturnType<typeof renderChildAgentBodyImpl>
  (
    arg0: Parameters<typeof renderChildAgentBodyImpl>[0],
    arg1: Parameters<typeof renderChildAgentBodyImpl>[1],
    arg2: Parameters<typeof renderChildAgentBodyImpl>[2],
    arg3: Parameters<typeof renderChildAgentBodyImpl>[3],
    arg4: Parameters<typeof renderChildAgentBodyImpl>[4],
    arg5: Parameters<typeof renderChildAgentBodyImpl>[5],
  ): ReturnType<typeof renderChildAgentBodyImpl>
} = Function.dual(6, renderChildAgentBodyImpl)

const compactionRainbow = ["#ff5f6d", "#ff9f43", "#ffd166", "#7bd389", "#5bc0eb", "#8c7ae6", "#d980fa"] as const

const renderPlainBodyImpl = (model: Model, block: TranscriptBlock, width: number, append: Append): void => {
  if (block._tag === "Compaction" && block.status === "complete") {
    append(fg(colors.green)(`${completedCompactionIcon} `))
    for (const [index, character] of Array.from("Auto-compacted").entries())
      append(fg(compactionRainbow[(index + model.animationTick) % compactionRainbow.length]!)(character))
    if (block.summary.length > 0) append(dim(fg(colors.text)(`\n${wrapBodyText(block.summary, width, "  ")}`)))
    return
  }
  let color = colors.text
  if (block._tag === "ContextUsage") color = colors.muted
  else if (block._tag === "Error") color = colors.red
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
