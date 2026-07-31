import { bold, fg, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import { colors } from "./theme"
import { wrapStyledChunks } from "./styled-text"
import type { ToolSummary } from "./transcript-presenter"

export const joinToolSummary = (summary: ToolSummary): string => summary.primary + (summary.secondary ?? "")

type ToolSummaryOptions = { readonly leading?: string; readonly selected?: boolean; readonly width?: number }

export const renderToolSummary: {
  (options?: ToolSummaryOptions): (summary: ToolSummary) => ReadonlyArray<ReadonlyArray<TextChunk>>
  (summary: ToolSummary, options?: ToolSummaryOptions): ReadonlyArray<ReadonlyArray<TextChunk>>
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "primary" in args[0],
  (summary: ToolSummary, options: ToolSummaryOptions = {}): ReadonlyArray<ReadonlyArray<TextChunk>> => {
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
