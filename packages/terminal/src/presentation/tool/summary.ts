import { bold, fg, underline } from "../markdown/styled-text-effects"
import type { TerminalTextChunk } from "../markdown/styled-text"
import { Function, Schema } from "effect"
import { colors } from "../terminal/theme"
import { wrapStyledChunks } from "../markdown/styled-text-wrapping"
import type { ToolSummary } from "../transcript/tool/detail-types"

export const joinToolSummary = (summary: ToolSummary): string => summary.primary + (summary.secondary ?? "")

type ToolSummaryOptions = {
  readonly leading?: string
  readonly selected?: boolean
  readonly underlineSecondary?: boolean
  readonly width?: number
}

export const renderToolSummary: {
  (options?: ToolSummaryOptions): (summary: ToolSummary) => ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
  (summary: ToolSummary, options?: ToolSummaryOptions): ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
} = Function.dual(
  (args) => Schema.is(Schema.Struct({ primary: Schema.String }))(args[0]),
  (summary: ToolSummary, options: ToolSummaryOptions = {}): ReadonlyArray<ReadonlyArray<TerminalTextChunk>> => {
    const leading = options.leading ?? ""
    const secondary: TerminalTextChunk[] = []
    if (summary.secondary !== undefined) {
      const color = options.selected === true ? colors.blue : colors.muted
      if (options.underlineSecondary === true) {
        // The summary separator is not part of the path's link styling.
        const separator = summary.secondary.match(/^\s*/)?.[0] ?? ""
        const path = summary.secondary.slice(separator.length)
        if (separator.length > 0) secondary.push(fg(color)(separator))
        if (path.length > 0) secondary.push(underline(fg(color)(path)))
      } else secondary.push(fg(color)(summary.secondary))
    }
    const chunks =
      options.selected === true
        ? [bold(fg(colors.blue)(summary.primary)), ...secondary.map(bold)]
        : [fg(colors.text)(summary.primary), ...secondary]
    const lines = wrapStyledChunks(chunks, options.width ?? Number.MAX_SAFE_INTEGER)
    if (leading.length > 0 && lines[0]?.[0] !== undefined)
      lines[0][0] = { ...lines[0][0], text: leading + lines[0][0].text }
    return lines
  },
)
