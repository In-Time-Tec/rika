import type { TextChunk } from "@opentui/core"
import { Function } from "effect"
import stringWidth from "string-width"

export type StyledLines = Array<Array<TextChunk>>

type StyledCell = { readonly chunk: TextChunk; readonly text: string; readonly width: number }
type WordPart = { readonly cells: Array<StyledCell>; readonly whitespace: boolean }

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const sameStyle = (left: TextChunk, right: TextChunk): boolean =>
  left.fg === right.fg &&
  left.bg === right.bg &&
  left.attributes === right.attributes &&
  left.link?.url === right.link?.url

const styledCells = (chunks: ReadonlyArray<TextChunk>): Array<StyledCell> => {
  const cells: Array<StyledCell> = []
  for (const chunk of chunks) {
    if (/^[\x20-\x7e]*$/u.test(chunk.text)) {
      for (const text of chunk.text) cells.push({ chunk, text, width: 1 })
    } else
      for (const { segment } of graphemeSegmenter.segment(chunk.text))
        cells.push({ chunk, text: segment, width: stringWidth(segment) })
  }
  return cells
}

const cellsToChunks = (cells: ReadonlyArray<StyledCell>): Array<TextChunk> => {
  const chunks: Array<TextChunk> = []
  for (const cell of cells) {
    const previous = chunks.at(-1)
    if (previous !== undefined && sameStyle(previous, cell.chunk)) previous.text += cell.text
    else chunks.push({ ...cell.chunk, text: cell.text })
  }
  return chunks
}

const cellsWidth = (cells: ReadonlyArray<StyledCell>): number => cells.reduce((total, cell) => total + cell.width, 0)

const wordParts = (cells: ReadonlyArray<StyledCell>): Array<WordPart> => {
  const parts: Array<WordPart> = []
  for (const cell of cells) {
    const whitespace = /^\s+$/u.test(cell.text)
    const previous = parts.at(-1)
    if (previous !== undefined && previous.whitespace === whitespace) previous.cells.push(cell)
    else parts.push({ cells: [cell], whitespace })
  }
  return parts
}

export const splitStyledChunks = (chunks: ReadonlyArray<TextChunk>): StyledLines => {
  const lines: StyledLines = [[]]
  for (const chunk of chunks)
    chunk.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length > 0) lines.at(-1)!.push({ ...chunk, text: piece })
    })
  return lines
}

export const wrapStyledLine: {
  (width: number): (chunks: ReadonlyArray<TextChunk>) => StyledLines
  (chunks: ReadonlyArray<TextChunk>, width: number): StyledLines
} = Function.dual(2, (chunks: ReadonlyArray<TextChunk>, width: number): StyledLines => {
  const lines: Array<Array<StyledCell>> = []
  let current: Array<StyledCell> = []
  let currentWidth = 0
  let pendingWhitespace: ReadonlyArray<StyledCell> = []
  const push = () => {
    lines.push(current)
    current = []
    currentWidth = 0
  }
  const appendWord = (cells: ReadonlyArray<StyledCell>) => {
    for (const cell of cells) {
      if (current.length > 0 && currentWidth + cell.width > width) push()
      current.push(cell)
      currentWidth += cell.width
    }
  }
  for (const part of wordParts(styledCells(chunks))) {
    if (part.whitespace) {
      pendingWhitespace = part.cells
      continue
    }
    const nextWidth = cellsWidth(pendingWhitespace) + cellsWidth(part.cells)
    if (current.length > 0 && currentWidth + nextWidth <= width) {
      current.push(...pendingWhitespace, ...part.cells)
      currentWidth += nextWidth
    } else {
      if (current.length > 0) push()
      appendWord(part.cells)
    }
    pendingWhitespace = []
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines.map(cellsToChunks)
})

export const wrapStyledChunks: {
  (width: number): (chunks: ReadonlyArray<TextChunk>) => StyledLines
  (chunks: ReadonlyArray<TextChunk>, width: number): StyledLines
} = Function.dual(
  2,
  (chunks: ReadonlyArray<TextChunk>, width: number): StyledLines =>
    splitStyledChunks(chunks).flatMap((line) => wrapStyledLine(line, width)),
)

export const hardWrapStyledLine: {
  (width: number): (chunks: ReadonlyArray<TextChunk>) => StyledLines
  (chunks: ReadonlyArray<TextChunk>, width: number): StyledLines
} = Function.dual(2, (chunks: ReadonlyArray<TextChunk>, width: number): StyledLines => {
  const lines: Array<Array<StyledCell>> = []
  let current: Array<StyledCell> = []
  let currentWidth = 0
  for (const cell of styledCells(chunks)) {
    if (current.length > 0 && currentWidth + cell.width > width) {
      lines.push(current)
      current = []
      currentWidth = 0
    }
    current.push(cell)
    currentWidth += cell.width
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines.map(cellsToChunks)
})

export const styledChunkCells = styledCells
export const styledCellsWidth = cellsWidth
