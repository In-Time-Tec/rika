import stringWidth from "string-width"
import { Function } from "effect"
import { bold, dim, fg, underline, type StyledText, type TextChunk } from "@opentui/core"
import type { TranscriptBlock } from "../../../state/transcript/model"
import type { Model } from "../../../state/model"
import { colors } from "../../../presentation/terminal/theme"
import { renderDiffStyled, renderPartialDiffStyled, renderPierreDiff } from "../diff-text-adapter"
import { isToolOutputDisplayed } from "../../../presentation/transcript/agent-response"
import { diffCounts } from "../tool/detail"
import { completedCompactionIcon, renderBlock } from "../block"
import type { TerminalTextChunk } from "../../../presentation/markdown/styled-text"

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
    append(bold(fg(selected ? colors.blue : colors.muted)("Δ ")))
    append(underline(bold(fg(selected ? colors.blue : colors.muted)(`${block.path}\n`))))
    appendAll(renderPierreDiff(block.patch, { width }) ?? renderDiffStyled(block.patch, { width }))
    return
  }
  const [added, removed] = diffCounts(block.patch)
  const verb = /^--- \/dev\/null$/m.test(block.patch) || /^new file mode /m.test(block.patch) ? "Created" : "Edited"
  append(selected ? bold(fg(colors.blue)("✓")) : fg(colors.green)("✓"))
  append(selected ? bold(fg(colors.blue)(` ${verb} `)) : fg(colors.text)(` ${verb} `))
  append(underline(selected ? bold(fg(colors.blue)(block.path)) : fg(colors.muted)(block.path)))
  append(fg(colors.green)(` +${added}`))
  append(fg(colors.red)(` -${removed}`))
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

export const renderNestedPatches = ({
  block,
  indent,
  width,
  append,
}: {
  readonly block: Extract<TranscriptBlock, { _tag: "ToolCall" }>
  readonly indent: string
  readonly width: number
  readonly append: Append
}): boolean => {
  const patches = block.files.filter((file) => file.patch.length > 0)
  for (const patch of patches) {
    const options = { width: Math.max(1, width - stringWidth(indent)), indent: 0 }
    const diff =
      renderPierreDiff(patch.patch, options) ??
      (patch.preview ? renderPartialDiffStyled(patch.patch, options) : undefined) ??
      renderDiffStyled(patch.patch, options)
    append(dim(fg(colors.subtle)(`\n${indent}`)))
    for (const chunk of diff.chunks) {
      const parts = chunk.text.split("\n")
      for (const [index, part] of parts.entries()) {
        if (index > 0) append(dim(fg(colors.subtle)(`\n${indent}`)))
        if (part.length > 0) append({ ...chunk, text: part })
      }
    }
  }
  return patches.length > 0
}
