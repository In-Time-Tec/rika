import { dim, fg, italic, type StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../../../state/model"
import { colors } from "../../../presentation/terminal/theme"
import type { TerminalTextChunk } from "../../../presentation/markdown/styled-text"
import { orderedTranscriptItems } from "../../../presentation/transcript/row"
import { renderMarkdownLines, renderMarkdownStyled } from "../text-adapter"
import { wrapTextToWidth } from "../window"
import { transcriptWrapWidth, type UnitLineRange } from "../transcript/window"
import type { AgentOutcome } from "../../../presentation/transcript/tool/types"

interface AgentContentContext {
  readonly model: Model
  readonly append: (chunk: TextChunk | TerminalTextChunk) => void
  readonly appendAll: (styled: StyledText) => void
  readonly line: () => number
}

const timelineCurl = (prefix: string, gap: boolean): string => {
  if (!gap) return prefix
  const connector = prefix.lastIndexOf("│")
  return connector < 0 ? prefix : `${prefix.slice(0, connector)}╰${prefix.slice(connector + 1)}`
}

export const createAgentContentRenderer = (context: AgentContentContext) => {
  const { model, append, appendAll } = context
  const renderEntryBody = (index: number) => {
    const entry = model.entries[index]!
    if (entry.role === "assistant") {
      appendAll(renderMarkdownStyled(entry.text.trimEnd(), transcriptWrapWidth(model.width)))
      return
    }
    if (entry.role === "notice") {
      append(fg(colors.amber)(entry.text === "cancelled" ? "⊘" : `! ${entry.text}`))
      return
    }
    const wrapped = wrapTextToWidth(entry.text, Math.max(1, transcriptWrapWidth(model.width) - 2))
    wrapped.forEach((current, lineIndex) => {
      if (lineIndex > 0) append(fg(colors.text)("\n"))
      append(fg(colors.green)("┃ "))
      append(italic(fg(colors.green)(current)))
    })
  }
  const renderAgentPrompt = (text: string, prefix: string) => {
    const rows = renderMarkdownLines(
      text.trimEnd(),
      Math.max(1, transcriptWrapWidth(model.width) - stringWidth(prefix)),
    )
    for (const row of rows) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(prefix)))
      for (const chunk of row) append(dim(chunk))
    }
  }
  const appendTimelineGap = (prefix: string, gap: boolean) => {
    if (!gap) return
    for (let spacer = 0; spacer < 2; spacer += 1) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(prefix.trimEnd())))
    }
  }
  const renderAgentResponse = (index: number, prefix: string, gap = false): UnitLineRange | undefined => {
    const entry = model.entries[index]
    if (entry?.role !== "assistant" || entry.text.trim().length === 0) return
    const item = orderedTranscriptItems(model).find(
      (candidate) => candidate._tag === "Entry" && candidate.index === index,
    )
    const rows = renderMarkdownLines(
      entry.text.trimEnd(),
      Math.max(1, transcriptWrapWidth(model.width) - stringWidth(prefix)),
    )
    const curl = timelineCurl(prefix, gap)
    const start = context.line() + 1
    appendTimelineGap(prefix, gap)
    rows.forEach((row, rowIndex) => {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(rowIndex === rows.length - 1 ? curl : prefix)))
      for (const chunk of row) append(chunk)
    })
    return {
      start,
      end: context.line(),
      unit: `entry:${item?.id ?? `${entry.turnId ?? "child"}:assistant:${index}`}`,
      expandable: false,
    }
  }
  const renderAgentError = (
    terminal: Extract<AgentOutcome, { kind: "error" }>,
    ownerId: string,
    prefix: string,
    gap = false,
  ): UnitLineRange | undefined => {
    const text = terminal.text.trim()
    if (text.length === 0) return
    const rows = renderMarkdownLines(text, Math.max(1, transcriptWrapWidth(model.width) - stringWidth(prefix)))
    const curl = timelineCurl(prefix, gap)
    const start = context.line() + 1
    appendTimelineGap(prefix, gap)
    rows.forEach((row, rowIndex) => {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(rowIndex === rows.length - 1 ? curl : prefix)))
      for (const chunk of row) {
        if (terminal.tone === "failed") append(fg(colors.red)(chunk))
        else if (terminal.tone === "cancelled") append(fg(colors.amber)(chunk))
        else append(dim(chunk))
      }
    })
    return { start, end: context.line(), unit: `agent-terminal:${ownerId}`, expandable: false }
  }
  return { renderAgentError, renderAgentPrompt, renderAgentResponse, renderEntryBody }
}
