export type TerminalColor =
  | string
  | object
  | { readonly _tag: "Indexed"; readonly index: number }
  | { readonly _tag: "DefaultBackground" }
export type TerminalTextChunk = {
  readonly __isChunk: true
  readonly text: string
  readonly fg?: TerminalColor
  readonly bg?: TerminalColor
  readonly attributes?: number
  readonly link?: { readonly url: string }
}
export const TextAttributes = { NONE: 0, BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, STRIKETHROUGH: 128 } as const
export type TerminalStyle = Readonly<{
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  strikethrough?: boolean
  reverse?: boolean
}>
export class TerminalStyledText {
  readonly chunks: ReadonlyArray<TerminalTextChunk>
  constructor(chunks: ReadonlyArray<TerminalTextChunk>) {
    this.chunks = chunks
  }
}
