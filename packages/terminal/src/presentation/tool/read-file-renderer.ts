import { Function } from "effect"
import stringWidth from "string-width"
import { TerminalStyledText, type TerminalTextChunk } from "../markdown/styled-text"
import { dim, fg } from "../markdown/styled-text-effects"
import { highlightLines, languageForPath } from "../markdown/syntax-highlighter"
import { colors } from "../terminal/theme"
import { clipLine } from "./pierre-diff-adapter"

export type ReadFileRenderOptions = {
  readonly path: string | undefined
  readonly width: number
  /** Text placed before every line, for example a tree prefix such as `│   `. */
  readonly indent?: string
}

type ReadLine = { readonly number: string | undefined; readonly content: string }

const numberedLine = /^(\d+): ?(.*)$/

const readLines = (text: string): ReadonlyArray<ReadLine> =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const match = numberedLine.exec(line)
      return match === null ? { number: undefined, content: line } : { number: match[1], content: match[2] ?? "" }
    })

/**
 * Renders the text a `read` tool returned as a numbered, syntax-highlighted listing. Lines that
 * carry a `N: ` prefix keep their number in a muted gutter; any other line (for example a
 * truncation notice) renders muted without a number.
 */
export const renderReadFile: {
  (options: ReadFileRenderOptions): (text: string) => TerminalStyledText
  (text: string, options: ReadFileRenderOptions): TerminalStyledText
} = Function.dual(2, (text: string, options: ReadFileRenderOptions): TerminalStyledText => {
  const indent = options.indent ?? "  "
  const lines = readLines(text)
  const numberWidth = Math.max(0, ...lines.map((line) => line.number?.length ?? 0))
  const lang = options.path === undefined ? undefined : languageForPath(options.path)
  const highlighted = highlightLines(lines.map((line) => line.content).join("\n"), lang)
  const chunks: Array<TerminalTextChunk> = []
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const gutter = numberWidth === 0 ? "" : `${(line.number ?? "").padStart(numberWidth)}  `
    if (indent.length > 0) chunks.push(dim(fg(colors.subtle)(indent)))
    if (gutter.length > 0) chunks.push(fg(colors.muted)(gutter))
    const content = line.number === undefined ? [fg(colors.muted)(line.content)] : (highlighted[index] ?? [])
    const contentWidth = Math.max(1, options.width - stringWidth(indent) - gutter.length)
    for (const chunk of clipLine(content, contentWidth)) chunks.push(chunk)
  })
  return new TerminalStyledText(chunks)
})
