import { bold, fg } from "../markdown/styled-text-effects"
import type { TerminalTextChunk } from "../markdown/styled-text"
import { Function } from "effect"
import { colors } from "../terminal/theme"
import { wrapStyledChunks } from "../markdown/styled-text-wrapping"
import type { ToolSummary } from "../transcript/tool/detail-types"

export const joinToolSummary = (summary: ToolSummary): string => summary.primary + (summary.secondary ?? "")

type ToolSummaryOptions = { readonly leading?: string; readonly selected?: boolean; readonly width?: number }

export const renderToolSummary: {
  (options?: ToolSummaryOptions): (summary: ToolSummary) => ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
  (summary: ToolSummary, options?: ToolSummaryOptions): ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "primary" in args[0],
  (summary: ToolSummary, options: ToolSummaryOptions = {}): ReadonlyArray<ReadonlyArray<TerminalTextChunk>> => {
    const leading = options.leading ?? ""
    const chunks =
      options.selected === true
        ? [bold(fg(colors.blue)(joinToolSummary(summary)))]
        : [
            fg(colors.text)(summary.primary),
            ...(summary.secondary === undefined ? [] : [fg(colors.muted)(summary.secondary)]),
          ]
    const lines = wrapStyledChunks(chunks, options.width ?? Number.MAX_SAFE_INTEGER)
    if (leading.length > 0 && lines[0]?.[0] !== undefined)
      lines[0]![0] = { ...lines[0]![0]!, text: leading + lines[0]![0]!.text }
    return lines
  },
)
