import { StyledText, bold, dim, fg, italic, link, strikethrough, underline, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import { Lexer, type Token, type Tokens } from "marked"
import stringWidth from "string-width"
import { highlightLines } from "./syntax-highlight"
import { colors } from "./theme"

type Lines = Array<Array<TextChunk>>

type StyledCell = {
  readonly chunk: TextChunk
  readonly text: string
  readonly width: number
}

type WordPart = {
  readonly cells: Array<StyledCell>
  readonly whitespace: boolean
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const terminalSafeText = (text: string): string =>
  text.replaceAll("\r\n", "\n").replace(/\p{Cc}/gu, (character) => (character === "\n" ? character : "�"))

const splitChunks = (chunks: ReadonlyArray<TextChunk>): Lines => {
  const lines: Lines = [[]]
  for (const chunk of chunks) {
    chunk.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length > 0) lines[lines.length - 1]!.push({ ...chunk, text: piece })
    })
  }
  return lines
}

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
      continue
    }
    for (const { segment } of graphemeSegmenter.segment(chunk.text)) {
      cells.push({ chunk, text: segment, width: stringWidth(segment) })
    }
  }
  return cells
}

const cellsToChunks = (cells: ReadonlyArray<StyledCell>): Array<TextChunk> => {
  const chunks: Array<TextChunk> = []
  for (const cell of cells) {
    const previous = chunks[chunks.length - 1]
    if (previous !== undefined && sameStyle(previous, cell.chunk)) previous.text += cell.text
    else chunks.push({ ...cell.chunk, text: cell.text })
  }
  return chunks
}

const wordParts = (cells: ReadonlyArray<StyledCell>): Array<WordPart> => {
  const parts: Array<WordPart> = []
  for (const cell of cells) {
    const whitespace = /^\s+$/u.test(cell.text)
    const previous = parts[parts.length - 1]
    if (previous !== undefined && previous.whitespace === whitespace) {
      previous.cells.push(cell)
    } else parts.push({ cells: [cell], whitespace })
  }
  return parts
}

const cellsWidth = (cells: ReadonlyArray<StyledCell>): number => cells.reduce((total, cell) => total + cell.width, 0)

const wrapChunkLine = (chunks: ReadonlyArray<TextChunk>, width: number): Lines => {
  const lines: Array<Array<StyledCell>> = []
  let current: Array<StyledCell> = []
  let currentWidth = 0
  let pendingWhitespace: ReadonlyArray<StyledCell> = []

  const pushCurrent = (): void => {
    lines.push(current)
    current = []
    currentWidth = 0
  }

  const appendWord = (cells: ReadonlyArray<StyledCell>): void => {
    for (const cell of cells) {
      if (current.length > 0 && currentWidth + cell.width > width) pushCurrent()
      current.push(cell)
      currentWidth += cell.width
    }
  }

  for (const part of wordParts(styledCells(chunks))) {
    if (part.whitespace) {
      pendingWhitespace = part.cells
      continue
    }
    const partWidth = cellsWidth(part.cells)
    const whitespaceWidth = cellsWidth(pendingWhitespace)
    if (current.length > 0 && currentWidth + whitespaceWidth + partWidth <= width) {
      current.push(...pendingWhitespace, ...part.cells)
      currentWidth += whitespaceWidth + partWidth
    } else {
      if (current.length > 0) pushCurrent()
      appendWord(part.cells)
    }
    pendingWhitespace = []
  }
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines.map(cellsToChunks)
}

const wrapChunks = (chunks: ReadonlyArray<TextChunk>, width: number): Lines =>
  splitChunks(chunks).flatMap((line) => wrapChunkLine(line, width))

const hardWrapChunkLine = (chunks: ReadonlyArray<TextChunk>, width: number): Lines => {
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
}

const trailingBlankLines = (raw: string): number => {
  const match = /\n+$/.exec(raw)
  return match === null ? 0 : Math.max(0, match[0].length - 1)
}

const inlineChunks = (tokens: ReadonlyArray<Token>, plain: boolean): Array<TextChunk> => {
  const chunks: Array<TextChunk> = []
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text
        if (text.tokens !== undefined && text.tokens.length > 0) chunks.push(...inlineChunks(text.tokens, plain))
        else chunks.push(fg(colors.text)(text.text))
        break
      }
      case "escape":
        chunks.push(fg(colors.text)((token as Tokens.Escape).text))
        break
      case "strong":
        chunks.push(...inlineChunks((token as Tokens.Strong).tokens, plain).map((chunk) => bold(chunk)))
        break
      case "em":
        chunks.push(...inlineChunks((token as Tokens.Em).tokens, plain).map((chunk) => italic(chunk)))
        break
      case "del":
        chunks.push(...inlineChunks((token as Tokens.Del).tokens, plain).map((chunk) => strikethrough(chunk)))
        break
      case "codespan":
        chunks.push(bold(fg(colors.amber)((token as Tokens.Codespan).text)))
        break
      case "link": {
        const linked = token as Tokens.Link
        if (plain) chunks.push(fg(colors.text)(`${linked.text} <${linked.href}>`))
        else chunks.push(link(linked.href)(underline(fg(colors.blue)(linked.text))))
        break
      }
      case "image":
        chunks.push(italic(fg(colors.blue)(`[Image: ${(token as Tokens.Image).text}]`)))
        break
      case "br":
        chunks.push(fg(colors.text)("\n"))
        break
      default:
        chunks.push(fg(colors.text)(token.raw))
    }
  }
  return chunks
}

const headingChunks = (heading: Tokens.Heading, plain: boolean): Array<TextChunk> =>
  inlineChunks(heading.tokens, plain).map((chunk) => {
    const colored = chunk.fg === colors.text ? fg(colors.teal)(chunk) : chunk
    switch (heading.depth) {
      case 1:
        return underline(bold(colored))
      case 2:
        return bold(colored)
      case 3:
        return underline(colored)
      case 4:
        return italic(colored)
      case 5:
        return colored
      case 6:
        return dim(colored)
    }
    return colored
  })

const distribute = (amount: number, weights: ReadonlyArray<number>): Array<number> => {
  if (amount <= 0) return weights.map(() => 0)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const exact = weights.map((weight) => (amount * weight) / total)
  const result = exact.map(Math.floor)
  let remaining = amount - result.reduce((sum, value) => sum + value, 0)
  for (const target of exact
    .map((value, position) => ({ position, fraction: value - Math.floor(value) }))
    .toSorted((left, right) => right.fraction - left.fraction || left.position - right.position)
    .map(({ position }) => position)) {
    if (remaining === 0) break
    result[target] = result[target]! + 1
    remaining -= 1
  }
  return result
}

const tableMeasurements = (
  table: Tokens.Table,
  plain: boolean,
): { readonly minimum: ReadonlyArray<number>; readonly natural: ReadonlyArray<number> } => {
  const rows: ReadonlyArray<ReadonlyArray<Tokens.TableCell>> = [table.header, ...table.rows]
  const cells = table.header.map((_, index) =>
    rows.map((row) => styledCells(inlineChunks(row[index]?.tokens ?? [], plain))),
  )
  return {
    minimum: cells.map((column) => Math.max(1, ...column.flatMap((cell) => cell.map((part) => part.width)))),
    natural: cells.map((column) => Math.max(1, ...column.map(cellsWidth))),
  }
}

const tableWidths = (natural: ReadonlyArray<number>, minimum: ReadonlyArray<number>, width: number): Array<number> => {
  const columns = natural.length
  const budget = width - columns * 3 - 1
  const naturalTotal = natural.reduce((sum, value) => sum + value, 0)
  if (naturalTotal <= budget) {
    const extra = distribute(
      budget - naturalTotal,
      natural.map((value) => value + 2),
    )
    return natural.map((value, index) => value + extra[index]!)
  }
  const minimumTotal = minimum.reduce((sum, value) => sum + value, 0)
  const extra = distribute(
    budget - minimumTotal,
    natural.map((value) => value + 2),
  )
  return minimum.map((value, index) => value + extra[index]!)
}

const cellLine = (
  content: ReadonlyArray<TextChunk>,
  width: number,
  align: Tokens.TableCell["align"],
): Array<TextChunk> => {
  const contentWidth = content.reduce((sum, chunk) => sum + stringWidth(chunk.text), 0)
  const remaining = Math.max(0, width - contentWidth)
  const left = align === "right" ? remaining : align === "center" ? Math.floor(remaining / 2) : 0
  const right = remaining - left
  return [fg(colors.text)(` ${" ".repeat(left)}`), ...content, fg(colors.text)(`${" ".repeat(right)} `)]
}

const tableRule = (left: string, join: string, right: string, widths: ReadonlyArray<number>): Array<TextChunk> => [
  dim(fg(colors.text)(`${left}${widths.map((width) => "─".repeat(width + 2)).join(join)}${right}`)),
]

const stackedTableLines = (table: Tokens.Table, plain: boolean, width: number): Lines => {
  const rows: ReadonlyArray<ReadonlyArray<Tokens.TableCell>> = [table.header, ...table.rows]
  const lines: Lines = []
  rows.forEach((cells, rowIndex) => {
    for (const cell of cells) lines.push(...wrapChunks(inlineChunks(cell.tokens, plain), width))
    if (rowIndex < rows.length - 1) lines.push([dim(fg(colors.text)("─".repeat(width)))])
  })
  return lines
}

const tableLines = (table: Tokens.Table, plain: boolean, width: number): Lines => {
  const measurements = tableMeasurements(table, plain)
  const minimumWidth = measurements.minimum.reduce((sum, value) => sum + value, 0) + table.header.length * 3 + 1
  if (width < minimumWidth) return stackedTableLines(table, plain, width)
  const widths = tableWidths(measurements.natural, measurements.minimum, width)
  const row = (cells: ReadonlyArray<Tokens.TableCell>): Lines => {
    const wrapped = cells.map((cell, index) => wrapChunks(inlineChunks(cell.tokens, plain), widths[index]!))
    const height = Math.max(1, ...wrapped.map((cell) => cell.length))
    return Array.from({ length: height }, (_, lineIndex) => {
      const chunks: Array<TextChunk> = [dim(fg(colors.text)("│"))]
      cells.forEach((cell, index) => {
        chunks.push(
          ...cellLine(wrapped[index]?.[lineIndex] ?? [], widths[index]!, cell.align),
          dim(fg(colors.text)("│")),
        )
      })
      return chunks
    })
  }
  const lines: Lines = [tableRule("╭", "┬", "╮", widths), ...row(table.header)]
  if (table.rows.length > 0) lines.push(tableRule("├", "┼", "┤", widths))
  table.rows.forEach((cells, index) => {
    lines.push(...row(cells))
    if (index < table.rows.length - 1) lines.push(tableRule("├", "┼", "┤", widths))
  })
  lines.push(tableRule("╰", "┴", "╯", widths))
  return lines
}

const listLines = (list: Tokens.List, depth: number, plain: boolean, width: number): Lines => {
  const lines: Lines = []
  const indent = "  ".repeat(depth)
  list.items.forEach((item, index) => {
    const markerMatch = /^[ \t]*((?:[-*+])|(?:\d{1,9}[.)]))[ \t]+/.exec(item.raw)
    const checkbox = item.task === true ? (item.checked === true ? "[x] " : "[ ] ") : ""
    const marker = `${indent}${markerMatch?.[1] ?? "-"} ${checkbox}`
    const continuation = " ".repeat(marker.length)
    const contentWidth = Math.max(1, width - stringWidth(marker))
    const itemLines: Lines = []
    const passthrough: Array<boolean> = []
    for (const token of item.tokens) {
      if (token.type === "checkbox") continue
      const isList = token.type === "list"
      for (const line of blockLines([token], depth + 1, plain, isList ? width : contentWidth)) {
        itemLines.push(line)
        passthrough.push(isList)
      }
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1]!.length === 0) {
      itemLines.pop()
      passthrough.pop()
    }
    if (itemLines.length === 0) itemLines.push([])
    let firstContent = true
    itemLines.forEach((line, lineIndex) => {
      if (passthrough[lineIndex] === true) lines.push(line)
      else if (firstContent) {
        lines.push([fg(colors.text)(marker), ...line])
        firstContent = false
      } else if (line.length === 0) lines.push([])
      else lines.push([fg(colors.text)(continuation), ...line])
    })
    if (list.loose && index < list.items.length - 1) lines.push([])
  })
  return lines
}

const blockLines = (tokens: ReadonlyArray<Token>, depth: number, plain: boolean, width: number): Lines => {
  const lines: Lines = []
  tokens.forEach((token) => {
    switch (token.type) {
      case "space": {
        const blanks = Math.max(0, (token.raw.match(/\n/g)?.length ?? 0) - 1)
        for (let index = 0; index < blanks; index += 1) lines.push([])
        return
      }
      case "heading": {
        const heading = token as Tokens.Heading
        lines.push(...wrapChunks(headingChunks(heading, plain), width))
        break
      }
      case "paragraph":
        lines.push(...wrapChunks(inlineChunks((token as Tokens.Paragraph).tokens, plain), width))
        break
      case "text": {
        const text = token as Tokens.Text
        if (text.tokens !== undefined && text.tokens.length > 0)
          lines.push(...wrapChunks(inlineChunks(text.tokens, plain), width))
        else lines.push(...wrapChunks([fg(colors.text)(text.text)], width))
        break
      }
      case "code": {
        const code = token as Tokens.Code
        const indent = " ".repeat(Math.min(4, Math.max(0, width - 1)))
        const contentWidth = Math.max(1, width - stringWidth(indent))
        for (const line of highlightLines(code.text, code.lang?.split(/\s/)[0])) {
          if (line.length === 0) lines.push([])
          else
            for (const wrapped of hardWrapChunkLine(line, contentWidth)) {
              lines.push([fg(colors.text)(indent), ...wrapped])
            }
        }
        break
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote
        for (const line of blockLines(quote.tokens, depth, plain, Math.max(1, width - 2))) {
          lines.push([dim(fg(colors.text)("│ ")), ...line])
        }
        break
      }
      case "list":
        lines.push(...listLines(token as Tokens.List, depth, plain, width))
        break
      case "table":
        lines.push(...tableLines(token as Tokens.Table, plain, width))
        break
      case "hr":
      case "html":
      default:
        lines.push(...splitChunks([fg(colors.text)(token.raw.replace(/\n+$/, ""))]))
        break
    }
    const blanks = trailingBlankLines(token.raw)
    for (let index = 0; index < blanks; index += 1) lines.push([])
  })
  return lines
}

const isPlainLine = (source: string): boolean => {
  if (source.includes("\n") || /[\\`*{}[\]<>()#+\-.!|>~:/@]/u.test(source)) return false
  for (let index = source.indexOf("_"); index >= 0; index = source.indexOf("_", index + 1)) {
    if (!/[\p{L}\p{N}]/u.test(source[index - 1] ?? "") || !/[\p{L}\p{N}]/u.test(source[index + 1] ?? "")) return false
  }
  return true
}

const renderLines = (source: string, plain: boolean, width: number): Lines => {
  const safeSource = terminalSafeText(source)
  if (isPlainLine(safeSource)) return wrapChunks([fg(colors.text)(safeSource)], width)
  const tokens = Lexer.lex(safeSource, { gfm: true })
  const lines = blockLines(tokens, 0, plain, Math.max(1, Math.floor(width)))
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop()
  return lines.map((line) => line.map((chunk) => ({ ...chunk, text: terminalSafeText(chunk.text) })))
}

export const renderMarkdown: {
  (source: string, width?: number): string
  (width?: number): (source: string) => string
} = Function.dual(
  (args) => typeof args[0] === "string",
  (source: string, width = 80): string =>
    renderLines(source, true, width)
      .map((line) => line.map((chunk) => chunk.text).join(""))
      .join("\n"),
)

export const renderMarkdownLines: {
  (source: string, width?: number): ReadonlyArray<ReadonlyArray<TextChunk>>
  (width?: number): (source: string) => ReadonlyArray<ReadonlyArray<TextChunk>>
} = Function.dual(
  (args) => typeof args[0] === "string",
  (source: string, width = 80): ReadonlyArray<ReadonlyArray<TextChunk>> => {
    const bounded = Math.max(1, Math.floor(width))
    return renderLines(source, false, bounded).flatMap((line) => {
      if (line.length === 0) return [[]]
      const lineWidth = line.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
      return lineWidth <= bounded ? [line] : wrapChunkLine(line, bounded)
    })
  },
)

export const renderMarkdownStyled: {
  (source: string, width?: number): StyledText
  (width?: number): (source: string) => StyledText
} = Function.dual(
  (args) => typeof args[0] === "string",
  (source: string, width = 80): StyledText => {
    const chunks: Array<TextChunk> = []
    renderLines(source, false, width).forEach((line, index) => {
      if (index > 0) chunks.push(fg(colors.text)("\n"))
      chunks.push(...line)
    })
    if (chunks.length === 0) chunks.push(fg(colors.text)(""))
    return new StyledText(chunks)
  },
)
