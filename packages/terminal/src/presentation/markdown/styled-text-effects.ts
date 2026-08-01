import type { TerminalColor, TerminalTextChunk, TerminalStyle } from "./styled-text"

const attributes = (style: TerminalStyle): number =>
  (style.bold ? 1 : 0) |
  (style.dim ? 2 : 0) |
  (style.italic ? 4 : 0) |
  (style.underline ? 8 : 0) |
  (style.reverse ? 32 : 0) |
  (style.strikethrough ? 128 : 0)
const apply = (input: string | TerminalTextChunk, style: TerminalStyle): TerminalTextChunk => {
  const chunk = typeof input === "string" ? { __isChunk: true as const, text: input } : input
  return { ...chunk, attributes: (chunk.attributes ?? 0) | attributes(style) }
}
export const fg =
  (color: TerminalColor) =>
  (input: string | TerminalTextChunk): TerminalTextChunk => ({ ...apply(input, {}), fg: color })
export const bg =
  (color: TerminalColor) =>
  (input: string | TerminalTextChunk): TerminalTextChunk => ({ ...apply(input, {}), bg: color })
export const bold = (input: string | TerminalTextChunk): TerminalTextChunk => apply(input, { bold: true })
export const italic = (input: string | TerminalTextChunk): TerminalTextChunk => apply(input, { italic: true })
export const underline = (input: string | TerminalTextChunk): TerminalTextChunk => apply(input, { underline: true })
export const strikethrough = (input: string | TerminalTextChunk): TerminalTextChunk =>
  apply(input, { strikethrough: true })
export const dim = (input: string | TerminalTextChunk): TerminalTextChunk => apply(input, { dim: true })
export const link =
  (url: string) =>
  (input: string | TerminalTextChunk): TerminalTextChunk => ({ ...apply(input, {}), link: { url } })
