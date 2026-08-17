import { animatedChunk, isAnimatedChunk } from "./opentui-render-window"
import { Function } from "effect"
import { RGBA, StyledText, type TextChunk } from "@opentui/core"
import {
  renderMarkdownLines as markdownLines,
  renderMarkdownStyled as markdownStyled,
} from "../../presentation/markdown/markdown-renderer"
import { highlightShellCommand as highlightCommand } from "../../presentation/markdown/syntax-highlighter"
import { wrapStyledLine as wrapLine } from "../../presentation/markdown/styled-text-wrapping"
import type { TerminalColor, TerminalStyledText, TerminalTextChunk } from "../../presentation/markdown/styled-text"

export { terminalSafeText } from "../../presentation/terminal/terminal-safe-text"

type TerminalColorWithInts = {
  readonly intent?: string
  readonly slot?: number
  readonly toInts: () => [number, number, number, number]
}

const isTerminalColorWithInts = (value: object): value is TerminalColorWithInts =>
  "toInts" in value && typeof value.toInts === "function"

const isIndexedTerminalColor = (value: object): value is { readonly _tag: "Indexed"; readonly index: number } =>
  "_tag" in value && value._tag === "Indexed" && "index" in value && typeof value.index === "number"

const toOpenColorImpl = (value: TerminalColor | RGBA | undefined): RGBA | undefined => {
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
    if (!value.startsWith("#")) return RGBA.fromIndex(indexes[value] ?? 7)
    if (typeof RGBA.fromHex === "function") return RGBA.fromHex(value)
    return RGBA.fromIndex(7)
  }
  if (isTerminalColorWithInts(value)) {
    if (value.intent === "indexed" && value.slot !== undefined) return RGBA.fromIndex(value.slot)
    if (value.intent === "default") return RGBA.defaultBackground()
    const ints = value.toInts()
    return RGBA.fromInts(ints[0], ints[1], ints[2], ints[3])
  }
  if (isIndexedTerminalColor(value)) return RGBA.fromIndex(value.index)
  return RGBA.defaultBackground()
}
export const toOpenColor: {
  (value: TerminalColor | RGBA): RGBA
  (value: TerminalColor | RGBA | undefined): RGBA | undefined
} = toOpenColorImpl as {
  (value: TerminalColor | RGBA): RGBA
  (value: TerminalColor | RGBA | undefined): RGBA | undefined
}
export const toOpenChunk = (chunk: TerminalTextChunk | TextChunk): TextChunk => {
  const fg = toOpenColor(chunk.fg),
    bg = toOpenColor(chunk.bg)
  const open: TextChunk = {
    __isChunk: true,
    text: chunk.text,
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(chunk.attributes === undefined ? {} : { attributes: chunk.attributes }),
    ...(chunk.link === undefined ? {} : { link: chunk.link }),
  }
  return isAnimatedChunk(chunk as TextChunk) ? animatedChunk(open) : open
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
const renderMarkdownLinesImpl = (source: string, width?: number): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  markdownLines(source, width).map((line) => line.map(toOpenChunk))

export const renderMarkdownLines: {
  (
    arg0: Parameters<typeof renderMarkdownLinesImpl>[0],
    arg1?: Parameters<typeof renderMarkdownLinesImpl>[1],
  ): ReturnType<typeof renderMarkdownLinesImpl>
  (
    arg1?: Parameters<typeof renderMarkdownLinesImpl>[1],
  ): (arg0: Parameters<typeof renderMarkdownLinesImpl>[0]) => ReturnType<typeof renderMarkdownLinesImpl>
} = Function.dual((args) => typeof args[0] === "string", renderMarkdownLinesImpl)
const renderMarkdownStyledImpl = (source: string, width?: number): StyledText =>
  toOpenText(markdownStyled(source, width))

export const renderMarkdownStyled: {
  (
    arg0: Parameters<typeof renderMarkdownStyledImpl>[0],
    arg1?: Parameters<typeof renderMarkdownStyledImpl>[1],
  ): ReturnType<typeof renderMarkdownStyledImpl>
  (
    arg1?: Parameters<typeof renderMarkdownStyledImpl>[1],
  ): (arg0: Parameters<typeof renderMarkdownStyledImpl>[0]) => ReturnType<typeof renderMarkdownStyledImpl>
} = Function.dual((args) => typeof args[0] === "string", renderMarkdownStyledImpl)
export const highlightShellCommand = (source: string): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  highlightCommand(source).map((line) => line.map(toOpenChunk))
const wrapStyledLineImpl = (line: ReadonlyArray<TextChunk>, width: number): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  wrapLine(line.map(terminalChunk), width).map((row) => row.map(toOpenChunk))

export const wrapStyledLine: {
  (
    arg1: Parameters<typeof wrapStyledLineImpl>[1],
  ): (arg0: Parameters<typeof wrapStyledLineImpl>[0]) => ReturnType<typeof wrapStyledLineImpl>
  (
    arg0: Parameters<typeof wrapStyledLineImpl>[0],
    arg1: Parameters<typeof wrapStyledLineImpl>[1],
  ): ReturnType<typeof wrapStyledLineImpl>
} = Function.dual(2, wrapStyledLineImpl)
