import { RGBA, StyledText, type TextChunk } from "@opentui/core"
import {
  renderMarkdownLines as markdownLines,
  renderMarkdownStyled as markdownStyled,
} from "../../presentation/markdown/markdown-renderer"
import { highlightShellCommand as highlightCommand } from "../../presentation/markdown/syntax-highlighter"
import { wrapStyledLine as wrapLine } from "../../presentation/markdown/styled-text"
import {
  renderDiffStyled as diffStyled,
  renderPartialDiffStyled as partialDiffStyled,
} from "../../presentation/tool/diff-renderer"
import { renderPierreDiff as pierreDiff, type DiffRenderOptions } from "../../presentation/tool/pierre-diff-adapter"
import { renderToolSummary as toolSummary } from "../../presentation/tool/tool-summary"
import type { TerminalColor, TerminalStyledText, TerminalTextChunk } from "../../presentation/markdown/styled-text"

export function toOpenColor(value: TerminalColor | RGBA): RGBA
export function toOpenColor(value: TerminalColor | RGBA | undefined): RGBA | undefined
export function toOpenColor(value: TerminalColor | RGBA | undefined): RGBA | undefined {
  if (value === undefined || value instanceof RGBA) return value
  if (typeof value === "string") {
    const indexes: Record<string, number> = {
      black: 0,
      red: 1,
      green: 2,
      yellow: 3,
      blue: 4,
      magenta: 5,
      cyan: 6,
      white: 7,
      brightBlack: 8,
    }
    return value.startsWith("#") ? RGBA.fromHex(value) : RGBA.fromIndex(indexes[value] ?? 7)
  }
  if ("toInts" in value && typeof value.toInts === "function") {
    const terminalColor = value as unknown as {
      readonly intent?: string
      readonly slot?: number
      readonly toInts: () => [number, number, number, number]
    }
    if (terminalColor.intent === "indexed" && terminalColor.slot !== undefined)
      return RGBA.fromIndex(terminalColor.slot)
    if (terminalColor.intent === "default") return RGBA.defaultBackground()
    const ints = terminalColor.toInts()
    return RGBA.fromInts(ints[0], ints[1], ints[2], ints[3])
  }
  if ("_tag" in value && value._tag === "Indexed" && typeof (value as { readonly index?: unknown }).index === "number")
    return RGBA.fromIndex((value as unknown as { readonly index: number }).index)
  return RGBA.defaultBackground()
}
export const toOpenChunk = (chunk: TerminalTextChunk | TextChunk): TextChunk => {
  const fg = chunk.fg as TextChunk["fg"],
    bg = chunk.bg as TextChunk["bg"]
  return {
    __isChunk: true,
    text: chunk.text,
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(chunk.attributes === undefined ? {} : { attributes: chunk.attributes }),
    ...(chunk.link === undefined ? {} : { link: chunk.link }),
  }
}
export const toOpenText = (text: TerminalStyledText): StyledText => new StyledText(text.chunks.map(toOpenChunk))
const terminalChunk = (chunk: TextChunk): TerminalTextChunk => ({
  __isChunk: true,
  text: chunk.text,
  attributes: chunk.attributes ?? 0,
  ...(chunk.fg === undefined ? {} : { fg: chunk.fg }),
  ...(chunk.bg === undefined ? {} : { bg: chunk.bg }),
  ...(chunk.link === undefined ? {} : { link: chunk.link }),
})
export const renderMarkdownLines = (source: string, width?: number): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  markdownLines(source, width).map((line) => line.map(toOpenChunk))
export const renderMarkdownStyled = (source: string, width?: number): StyledText =>
  toOpenText(markdownStyled(source, width))
export const highlightShellCommand = (source: string): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  highlightCommand(source).map((line) => line.map(toOpenChunk))
export const wrapStyledLine = (
  line: ReadonlyArray<TextChunk>,
  width: number,
): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  wrapLine(line.map(terminalChunk), width).map((row) => row.map(toOpenChunk))
export const renderDiffStyled = (patch: string, options: Parameters<typeof diffStyled>[1]): StyledText =>
  toOpenText(diffStyled(patch, options))
export const renderPartialDiffStyled = (
  patch: string,
  options: Parameters<typeof partialDiffStyled>[1],
): StyledText | undefined => {
  const result = partialDiffStyled(patch, options)
  return result === undefined ? undefined : toOpenText(result)
}
export const renderPierreDiff = (patch: string, options: DiffRenderOptions): StyledText | undefined => {
  const result = pierreDiff(options)(patch)
  return result === undefined ? undefined : toOpenText(result)
}
export const renderToolSummary = (
  summary: Parameters<typeof toolSummary>[0],
  options?: Parameters<typeof toolSummary>[1],
): ReadonlyArray<ReadonlyArray<TextChunk>> => toolSummary(summary, options).map((line) => line.map(toOpenChunk))
