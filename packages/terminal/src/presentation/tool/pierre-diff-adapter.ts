import { TerminalStyledText, type TerminalTextChunk } from "../markdown/styled-text"
import { fg } from "../markdown/styled-text-effects"
import { parsePatchFiles } from "@pierre/diffs"
import { Function } from "effect"
import { highlightLines, languageForPath } from "../markdown/syntax-highlighter"
import { colors } from "../terminal/theme"

const strip = (line: string | undefined): string => (line ?? "").replace(/\r?\n$/, "")

const hunkStarts = (spec: string) => {
  const match = /-(\d+)(?:,\d+)? \+(\d+)/.exec(spec)
  return { oldStart: Number(match?.[1] ?? 1), newStart: Number(match?.[2] ?? 1) }
}

export type DiffRenderOptions = { readonly width: number; readonly indent?: number }

type Row =
  | { readonly ellipsis: true }
  | {
      readonly number: number
      readonly marker: " " | "+" | "-"
      readonly content: string
      readonly lang: string | undefined
    }

const clipLine = (chunks: ReadonlyArray<TerminalTextChunk>, width: number): ReadonlyArray<TerminalTextChunk> => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
  if (total <= width) return chunks
  const budget = Math.max(0, width - 1)
  const clipped: Array<TerminalTextChunk> = []
  let used = 0
  for (const chunk of chunks) {
    if (used >= budget) break
    const take = Math.min(chunk.text.length, budget - used)
    clipped.push(take === chunk.text.length ? chunk : { ...chunk, text: chunk.text.slice(0, take) })
    used += take
  }
  clipped.push(fg(colors.muted)("…"))
  return clipped
}

const contentChunks = (row: Extract<Row, { number: number }>): ReadonlyArray<TerminalTextChunk> => {
  if (row.content.length === 0) return []
  if (row.marker === "-") return [fg(colors.red)(row.content)]
  if (row.marker === "+") return [fg(colors.green)(row.content)]
  if (row.lang === undefined) return [fg(colors.muted)(row.content)]
  return highlightLines(row.content, row.lang)[0] ?? []
}

const pierreCache = new Map<string, ReadonlyArray<TerminalTextChunk> | null>()
const pierreCacheLimit = 256

type ParsedFile = ReturnType<typeof parsePatchFiles>[number]["files"][number]

const appendHunkRows = (rows: Array<Row>, file: ParsedFile): boolean => {
  let hasContent = false
  const lang = languageForPath(file.name)
  for (const hunk of file.hunks) {
    const { oldStart, newStart } = hunkStarts(hunk.hunkSpecs ?? "")
    if (newStart > 1 || rows.length > 0) rows.push({ ellipsis: true })
    for (const group of hunk.hunkContent) {
      const contextLines = group.type === "context" ? group.lines : 0
      for (let index = 0; index < contextLines; index += 1) {
        rows.push({
          number: newStart + group.additionLineIndex + index,
          marker: " ",
          content: strip(file.additionLines[group.additionLineIndex + index]),
          lang,
        })
        hasContent = true
      }
      if (group.type === "context") continue
      for (let index = 0; index < group.deletions; index += 1) {
        rows.push({
          number: oldStart + group.deletionLineIndex + index,
          marker: "-",
          content: strip(file.deletionLines[group.deletionLineIndex + index]),
          lang,
        })
        hasContent = true
      }
      for (let index = 0; index < group.additions; index += 1) {
        rows.push({
          number: newStart + group.additionLineIndex + index,
          marker: "+",
          content: strip(file.additionLines[group.additionLineIndex + index]),
          lang,
        })
        hasContent = true
      }
    }
  }
  return hasContent
}

const diffRows = (parsed: ReturnType<typeof parsePatchFiles>): ReadonlyArray<Row> | undefined => {
  const rows: Array<Row> = []
  let hasContent = false
  for (const result of parsed) for (const file of result.files) hasContent = appendHunkRows(rows, file) || hasContent
  return hasContent ? rows : undefined
}

export const renderPierreDiff: {
  (options: DiffRenderOptions): (patch: string) => TerminalStyledText | undefined
  (patch: string, options: DiffRenderOptions): TerminalStyledText | undefined
} = Function.dual(2, (patch: string, options: DiffRenderOptions): TerminalStyledText | undefined => {
  const key = `${options.indent ?? 2}:${options.width}:${patch}`
  const cached = pierreCache.get(key)
  if (cached !== undefined) return cached === null ? undefined : new TerminalStyledText([...cached])
  const chunks = renderPierreDiffChunks(patch, options)
  if (pierreCache.size >= pierreCacheLimit) {
    const oldest = pierreCache.keys().next().value
    if (oldest !== undefined) pierreCache.delete(oldest)
  }
  pierreCache.set(key, chunks)
  return chunks === null ? undefined : new TerminalStyledText([...chunks])
})

const renderPierreDiffChunks = (patch: string, options: DiffRenderOptions): ReadonlyArray<TerminalTextChunk> | null => {
  const { width } = options
  const indent = " ".repeat(options.indent ?? 2)
  let parsed: ReturnType<typeof parsePatchFiles>
  try {
    parsed = parsePatchFiles(patch)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const rows = diffRows(parsed)
  if (rows === undefined) return null
  const numberWidth = Math.max(1, ...rows.flatMap((row) => ("ellipsis" in row ? [] : [String(row.number).length])))
  const chunks: Array<TerminalTextChunk> = []
  rows.forEach((row, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if ("ellipsis" in row) {
      chunks.push(fg(colors.muted)(`${indent}...`))
      return
    }
    const gutter = `${indent}${String(row.number).padStart(numberWidth)} ${row.marker} `
    let gutterColor = colors.muted
    if (row.marker === "+") gutterColor = colors.green
    else if (row.marker === "-") gutterColor = colors.red
    chunks.push(fg(gutterColor)(gutter))
    for (const chunk of clipLine(contentChunks(row), Math.max(1, width - gutter.length))) chunks.push(chunk)
  })
  return chunks
}
