import { TerminalStyledText, type TerminalTextChunk } from "./styled-text"
import { bold, dim, fg, italic, link, strikethrough, underline } from "./styled-text-effects"
import { Function, Predicate } from "effect"
import { Lexer, type Token, type Tokens } from "marked"
import stringWidth from "string-width"
import {
  hardWrapStyledLine as hardWrapChunkLine,
  splitStyledChunks as splitChunks,
  styledCellsWidth as cellsWidth,
  styledChunkCells as styledCells,
  wrapStyledChunks as wrapChunks,
  wrapStyledLine as wrapChunkLine,
  type StyledLines as Lines,
} from "./styled-text-wrapping"
import { highlightLines } from "./syntax-highlighter"
import { colors } from "../terminal/theme"
import { terminalSafeText } from "../terminal/safe-text"

const isHeadingToken = (token: Token): token is Tokens.Heading =>
  token.type === "heading" && Predicate.hasProperty(token, "depth") && Predicate.isNumber(token.depth)

const isListToken = (token: Token): token is Tokens.List =>
  token.type === "list" && Predicate.hasProperty(token, "items") && Array.isArray(token.items)

const isTableToken = (token: Token): token is Tokens.Table =>
  token.type === "table" &&
  Predicate.hasProperty(token, "header") &&
  Array.isArray(token.header) &&
  Predicate.hasProperty(token, "rows") &&
  Array.isArray(token.rows)

const isTextToken = (token: Token): token is Tokens.Text =>
  token.type === "text" && Predicate.hasProperty(token, "text") && Predicate.isString(token.text)

const isCodeToken = (token: Token): token is Tokens.Code =>
  token.type === "code" && Predicate.hasProperty(token, "text") && Predicate.isString(token.text)

const trailingBlankLines = (raw: string): number => {
  const match = /\n+$/.exec(raw)
  return match === null ? 0 : Math.max(0, match[0].length - 1)
}

const textTokenChunks = (token: Tokens.Text, plain: boolean): Array<TerminalTextChunk> =>
  token.tokens !== undefined && token.tokens.length > 0
    ? inlineChunks(token.tokens, plain)
    : [fg(colors.text)(token.text)]

const inlineTokenChunks = (token: Token, plain: boolean): Array<TerminalTextChunk> => {
  switch (token.type) {
    case "text":
      return isTextToken(token) ? textTokenChunks(token, plain) : [fg(colors.text)(token.raw)]
    case "escape":
      return [fg(colors.text)(String(token.text))]
    case "strong":
      return inlineChunks(token.tokens ?? [], plain).map((chunk) => bold(chunk))
    case "em":
      return inlineChunks(token.tokens ?? [], plain).map((chunk) => italic(chunk))
    case "del":
      return inlineChunks(token.tokens ?? [], plain).map((chunk) => strikethrough(chunk))
    case "codespan":
      return [bold(fg(colors.amber)(String(token.text)))]
    case "link":
      return plain
        ? [fg(colors.text)(`${String(token.text)} <${String(token.href)}>`)]
        : [link(String(token.href))(underline(fg(colors.blue)(String(token.text))))]
    case "image":
      return [italic(fg(colors.blue)(`[Image: ${token.text}]`))]
    case "br":
      return [fg(colors.text)("\n")]
    default:
      return [fg(colors.text)(token.raw)]
  }
}

const inlineChunks = (tokens: ReadonlyArray<Token>, plain: boolean): Array<TerminalTextChunk> =>
  tokens.flatMap((token) => inlineTokenChunks(token, plain))

const headingChunks = (heading: Tokens.Heading, plain: boolean): Array<TerminalTextChunk> =>
  inlineChunks(heading.tokens, plain).map((chunk) => bold(chunk))

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
    result[target]! += 1
    remaining -= 1
  }
  return result
}

const tableMeasurements = (table: Tokens.Table, plain: boolean) => {
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
  content: ReadonlyArray<TerminalTextChunk>,
  width: number,
  align: Tokens.TableCell["align"],
): Array<TerminalTextChunk> => {
  const contentWidth = content.reduce((sum, chunk) => sum + stringWidth(chunk.text), 0)
  const remaining = Math.max(0, width - contentWidth)
  let left = 0
  if (align === "right") left = remaining
  else if (align === "center") left = Math.floor(remaining / 2)
  const right = remaining - left
  return [fg(colors.text)(` ${" ".repeat(left)}`), ...content, fg(colors.text)(`${" ".repeat(right)} `)]
}

const tableRule = (
  left: string,
  join: string,
  right: string,
  widths: ReadonlyArray<number>,
): Array<TerminalTextChunk> => [
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
      const chunks: Array<TerminalTextChunk> = [dim(fg(colors.text)("│"))]
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
    let checkbox = ""
    if (item.task === true) checkbox = item.checked === true ? "[x] " : "[ ] "
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

const rawBlockLines = (token: Token): Lines => splitChunks([fg(colors.text)(token.raw.replace(/\n+$/u, ""))])

const codeBlockLines = (token: Tokens.Code, width: number): Lines => {
  const lines: Lines = []
  const indent = " ".repeat(Math.min(4, Math.max(0, width - 1)))
  const contentWidth = Math.max(1, width - stringWidth(indent))
  const language = token.lang?.split(/\s/)[0]
  for (const line of highlightLines(token.text, language)) {
    if (line.length === 0) lines.push([])
    else
      for (const wrapped of hardWrapChunkLine(line, contentWidth)) {
        lines.push([fg(colors.text)(indent), ...wrapped])
      }
  }
  return lines
}

const textBlockLines = (token: Token, plain: boolean, width: number): Lines => {
  if (!isTextToken(token)) return rawBlockLines(token)
  return token.tokens !== undefined && token.tokens.length > 0
    ? wrapChunks(inlineChunks(token.tokens, plain), width)
    : wrapChunks([fg(colors.text)(token.text)], width)
}

const structuredBlockLines = (token: Token, depth: number, plain: boolean, width: number): Lines => {
  if (token.type === "heading" && isHeadingToken(token)) return wrapChunks(headingChunks(token, plain), width)
  if (token.type === "list" && isListToken(token)) return listLines(token, depth, plain, width)
  if (token.type === "table" && isTableToken(token)) return tableLines(token, plain, width)
  return rawBlockLines(token)
}

const blockTokenLines = (token: Token, depth: number, plain: boolean, width: number): Lines => {
  switch (token.type) {
    case "space": {
      const blanks = Math.max(0, (token.raw.match(/\n/g)?.length ?? 0) - 1)
      return Array.from({ length: blanks }, () => [])
    }
    case "heading":
      return structuredBlockLines(token, depth, plain, width)
    case "paragraph":
      return wrapChunks(inlineChunks(token.tokens ?? [], plain), width)
    case "text":
      return textBlockLines(token, plain, width)
    case "code":
      return isCodeToken(token) ? codeBlockLines(token, width) : rawBlockLines(token)
    case "blockquote": {
      return blockLines(token.tokens ?? [], depth, plain, Math.max(1, width - 2)).map((line) => [
        dim(fg(colors.text)("│ ")),
        ...line,
      ])
    }
    case "list":
      return structuredBlockLines(token, depth, plain, width)
    case "table":
      return structuredBlockLines(token, depth, plain, width)
    default:
      return rawBlockLines(token)
  }
}

const blockLinesCache = new Map<string, Lines>()
const blockLinesCacheLimit = 256

const cachedBlockTokenLines = (token: Token, depth: number, plain: boolean, width: number): Lines => {
  const key = `${plain ? "p" : "m"}:${width}:${depth}:${JSON.stringify(token)}`
  const cached = blockLinesCache.get(key)
  if (cached !== undefined) return cached
  const lines = blockTokenLines(token, depth, plain, width).flatMap((line) => {
    const safe = line.map((chunk) => ({ ...chunk, text: terminalSafeText(chunk.text) }))
    const lineWidth = safe.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
    return lineWidth <= width ? [safe] : wrapChunkLine(safe, width)
  })
  if (token.raw.length <= 4_096) {
    if (blockLinesCache.size >= blockLinesCacheLimit) {
      const oldest = blockLinesCache.keys().next().value
      if (oldest !== undefined) blockLinesCache.delete(oldest)
    }
    blockLinesCache.set(key, lines)
  }
  return lines
}

const blockLines = (tokens: ReadonlyArray<Token>, depth: number, plain: boolean, width: number): Lines => {
  const lines: Lines = []
  tokens.forEach((token) => {
    lines.push(...cachedBlockTokenLines(token, depth, plain, width))
    if (token.type === "space") return
    const blanks = trailingBlankLines(token.raw)
    for (let index = 0; index < blanks; index += 1) lines.push([])
  })
  return lines
}

const isPlainLine = (source: string): boolean => {
  // An interior hyphen is plain text; a leading dash can introduce a list, rule, or Setext heading.
  if (/[\\`*{}[\]<>()#+.!|>~:/@]/u.test(source) || /^\s*-/u.test(source)) return false
  for (let index = source.indexOf("_"); index >= 0; index = source.indexOf("_", index + 1)) {
    if (!/[\p{L}\p{N}]/u.test(source[index - 1] ?? "") || !/[\p{L}\p{N}]/u.test(source[index + 1] ?? "")) return false
  }
  return true
}

let markdownLexerInvocations = 0
let markdownCacheBytes = 0

const renderLinesUncached = (source: string, plain: boolean, width: number): Lines => {
  const safeSource = terminalSafeText(source)
  if (safeSource.split("\n").every(isPlainLine)) return wrapChunks([fg(colors.text)(safeSource)], width)
  markdownLexerInvocations += 1
  const tokens = Lexer.lex(safeSource, { gfm: true })
  const lines = blockLines(tokens, 0, plain, Math.max(1, Math.floor(width)))
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop()
  return lines
}

const renderLinesCache = new Map<string, Lines>()
const renderLinesCacheLimit = 128
const renderLinesCacheSourceLimit = 4_096

const renderLines = (source: string, plain: boolean, width: number): Lines => {
  const key = `${plain ? "p" : "m"}:${width}:${source}`
  const cached = renderLinesCache.get(key)
  if (cached !== undefined) return cached
  const lines = renderLinesUncached(source, plain, width)
  if (source.length <= renderLinesCacheSourceLimit) {
    if (renderLinesCache.size >= renderLinesCacheLimit) {
      const oldest = renderLinesCache.keys().next().value
      if (oldest !== undefined) {
        markdownCacheBytes -= oldest.length * 2
        renderLinesCache.delete(oldest)
      }
    }
    renderLinesCache.set(key, lines)
    markdownCacheBytes += key.length * 2
  }
  return lines
}

export const markdownRendererDiagnostics = () => ({
  lexerInvocations: markdownLexerInvocations,
  cacheEntries: renderLinesCache.size,
  cacheBytes: markdownCacheBytes,
})

export const resetMarkdownRendererDiagnostics = (): void => {
  markdownLexerInvocations = 0
  markdownCacheBytes = 0
  renderLinesCache.clear()
  blockLinesCache.clear()
}

export const renderMarkdown: {
  (source: string, width?: number): string
  (width?: number): (source: string) => string
} = Function.dual(
  (args) => Predicate.isString(args[0]),
  (source: string, width: number = 80): string =>
    renderLines(source, true, width)
      .map((line) => line.map((chunk) => chunk.text).join(""))
      .join("\n"),
)

export const renderMarkdownLines: {
  (source: string, width?: number): ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
  (width?: number): (source: string) => ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
} = Function.dual(
  (args) => Predicate.isString(args[0]),
  (source: string, width: number = 80): ReadonlyArray<ReadonlyArray<TerminalTextChunk>> => {
    const bounded = Math.max(1, Math.floor(width))
    return renderLines(source, false, bounded)
  },
)

export const renderMarkdownStyled: {
  (source: string, width?: number): TerminalStyledText
  (width?: number): (source: string) => TerminalStyledText
} = Function.dual(
  (args) => Predicate.isString(args[0]),
  (source: string, width: number = 80): TerminalStyledText => {
    const chunks: Array<TerminalTextChunk> = []
    renderLines(source, false, width).forEach((line, index) => {
      if (index > 0) chunks.push(fg(colors.text)("\n"))
      chunks.push(...line)
    })
    if (chunks.length === 0) chunks.push(fg(colors.text)(""))
    return new TerminalStyledText(chunks)
  },
)
