import { Function, Predicate } from "effect"
import { RGBA, StyledText, type TextChunk } from "@opentui/core"
import {
  renderMarkdownLines as markdownLines,
  renderMarkdownStyled as markdownStyled,
} from "../../presentation/markdown/renderer"
import { highlightShellCommand as highlightCommand } from "../../presentation/markdown/syntax-highlighter"
import { wrapStyledLine as wrapLine } from "../../presentation/markdown/styled-text-wrapping"
import type { TerminalColor, TerminalStyledText, TerminalTextChunk } from "../../presentation/markdown/styled-text"

export { terminalSafeText } from "../../presentation/terminal/safe-text"

type TerminalColorWithInts = {
  readonly intent?: string
  readonly slot?: number
  readonly toInts: () => [number, number, number, number]
}

type TerminalObjectColor = Exclude<TerminalColor, string>

interface TerminalChunkOptions {
  __isChunk: true
  text: string
  attributes: number
  fg?: TerminalColor
  bg?: TerminalColor
  link?: { readonly url: string }
}

const isTerminalColorWithInts = (value: TerminalObjectColor): value is TerminalColorWithInts =>
  Predicate.hasProperty(value, "toInts") && Predicate.isFunction(value.toInts)

const isIndexedTerminalColor = (
  value: TerminalObjectColor,
): value is { readonly _tag: "Indexed"; readonly index: number } =>
  Predicate.hasProperty(value, "_tag") &&
  value._tag === "Indexed" &&
  Predicate.hasProperty(value, "index") &&
  Predicate.isNumber(value.index)

const toOpenColorImpl = (value: TerminalColor | RGBA | undefined): RGBA | undefined => {
  if (value === undefined || value instanceof RGBA) return value
  if (Predicate.isString(value)) {
    const indexes = new Map([
      ["black", 0],
      ["red", 1],
      ["green", 2],
      ["yellow", 3],
      ["blue", 4],
      ["magenta", 5],
      ["cyan", 6],
      ["white", 7],
      ["brightBlack", 8],
    ])
    if (!value.startsWith("#")) return RGBA.fromIndex(indexes.get(value) ?? 7)
    return RGBA.fromHex(value)
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
export function toOpenColor(value: TerminalColor | RGBA): RGBA
export function toOpenColor(value: TerminalColor | RGBA | undefined): RGBA | undefined
export function toOpenColor(value: TerminalColor | RGBA | undefined): RGBA | undefined {
  return toOpenColorImpl(value)
}
export const toOpenChunk = (chunk: TerminalTextChunk | TextChunk): TextChunk => {
  const fg = toOpenColor(chunk.fg),
    bg = toOpenColor(chunk.bg)
  const openChunk: TextChunk = {
    __isChunk: true,
    text: chunk.text,
  }
  if (fg !== undefined) openChunk.fg = fg
  if (bg !== undefined) openChunk.bg = bg
  if (chunk.attributes !== undefined) openChunk.attributes = chunk.attributes
  if (chunk.link !== undefined) openChunk.link = chunk.link
  return openChunk
}
export const toOpenText = (text: TerminalStyledText): StyledText => new StyledText(text.chunks.map(toOpenChunk))
const terminalChunk = (chunk: TextChunk): TerminalTextChunk => {
  const terminal: TerminalChunkOptions = { __isChunk: true, text: chunk.text, attributes: chunk.attributes ?? 0 }
  if (chunk.fg !== undefined) terminal.fg = chunk.fg
  if (chunk.bg !== undefined) terminal.bg = chunk.bg
  if (chunk.link !== undefined) terminal.link = chunk.link
  return terminal
}
const markdownLineCache = new WeakMap<ReadonlyArray<TerminalTextChunk>, ReadonlyArray<TextChunk>>()
const renderMarkdownLinesImpl = (source: string, width?: number): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  markdownLines(source, width).map((line) => {
    const cached = markdownLineCache.get(line)
    if (cached !== undefined) return cached
    const converted = line.map(toOpenChunk)
    markdownLineCache.set(line, converted)
    return converted
  })

export const renderMarkdownLines: {
  (
    arg0: Parameters<typeof renderMarkdownLinesImpl>[0],
    arg1?: Parameters<typeof renderMarkdownLinesImpl>[1],
  ): ReturnType<typeof renderMarkdownLinesImpl>
  (
    arg1?: Parameters<typeof renderMarkdownLinesImpl>[1],
  ): (arg0: Parameters<typeof renderMarkdownLinesImpl>[0]) => ReturnType<typeof renderMarkdownLinesImpl>
} = Function.dual((args) => Predicate.isString(args[0]), renderMarkdownLinesImpl)
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
} = Function.dual((args) => Predicate.isString(args[0]), renderMarkdownStyledImpl)
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
