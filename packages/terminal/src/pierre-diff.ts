import { StyledText, fg, type TextChunk } from "@opentui/core"
import { parsePatchFiles } from "@pierre/diffs"
import { Function } from "effect"
import { highlightLines, languageForPath } from "./syntax-highlight"
import { colors } from "./theme"

const strip = (line: string | undefined): string => (line ?? "").replace(/\r?\n$/, "")

const hunkStarts = (spec: string): { readonly oldStart: number; readonly newStart: number } => {
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

const clipLine = (chunks: ReadonlyArray<TextChunk>, width: number): ReadonlyArray<TextChunk> => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
  if (total <= width) return chunks
  const budget = Math.max(0, width - 1)
  const clipped: Array<TextChunk> = []
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

const contentChunks = (row: Extract<Row, { number: number }>): ReadonlyArray<TextChunk> => {
  if (row.content.length === 0) return []
  if (row.marker === "-") return [fg(colors.red)(row.content)]
  if (row.marker === "+") return [fg(colors.green)(row.content)]
  if (row.lang === undefined) return [fg(colors.muted)(row.content)]
  return highlightLines(row.content, row.lang)[0] ?? []
}

const pierreCache = new Map<string, ReadonlyArray<TextChunk> | null>()
const pierreCacheLimit = 256

export const renderPierreDiff: {
  (options: DiffRenderOptions): (patch: string) => StyledText | undefined
  (patch: string, options: DiffRenderOptions): StyledText | undefined
} = Function.dual(2, (patch: string, options: DiffRenderOptions): StyledText | undefined => {
  const key = `${options.indent ?? 2}:${options.width}:${patch}`
  const cached = pierreCache.get(key)
  if (cached !== undefined) return cached === null ? undefined : new StyledText([...cached])
  const chunks = renderPierreDiffChunks(patch, options)
  if (pierreCache.size >= pierreCacheLimit) pierreCache.delete(pierreCache.keys().next().value!)
  pierreCache.set(key, chunks)
  return chunks === null ? undefined : new StyledText([...chunks])
})

const renderPierreDiffChunks = (patch: string, options: DiffRenderOptions): ReadonlyArray<TextChunk> | null => {
  const { width } = options
  const indent = " ".repeat(options.indent ?? 2)
  let parsed: ReturnType<typeof parsePatchFiles>
  try {
    parsed = parsePatchFiles(patch)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const rows: Array<Row> = []
  let hasContent = false
  for (const result of parsed as ReadonlyArray<{ files?: ReadonlyArray<Record<string, any>> }>)
    for (const file of result.files ?? []) {
      const additions: ReadonlyArray<string> = file.additionLines ?? []
      const deletions: ReadonlyArray<string> = file.deletionLines ?? []
      const lang = languageForPath(String(file.name ?? ""))
      for (const hunk of (file.hunks ?? []) as ReadonlyArray<Record<string, any>>) {
        const { oldStart, newStart } = hunkStarts(String(hunk.hunkSpecs ?? ""))
        if (newStart > 1 || rows.length > 0) rows.push({ ellipsis: true })
        for (const group of (hunk.hunkContent ?? []) as ReadonlyArray<Record<string, any>>) {
          if (group.type === "context") {
            for (let index = 0; index < Number(group.lines ?? 0); index += 1) {
              rows.push({
                number: newStart + Number(group.additionLineIndex ?? 0) + index,
                marker: " ",
                content: strip(additions[Number(group.additionLineIndex ?? 0) + index]),
                lang,
              })
              hasContent = true
            }
          } else {
            for (let index = 0; index < Number(group.deletions ?? 0); index += 1) {
              rows.push({
                number: oldStart + Number(group.deletionLineIndex ?? 0) + index,
                marker: "-",
                content: strip(deletions[Number(group.deletionLineIndex ?? 0) + index]),
                lang,
              })
              hasContent = true
            }
            for (let index = 0; index < Number(group.additions ?? 0); index += 1) {
              rows.push({
                number: newStart + Number(group.additionLineIndex ?? 0) + index,
                marker: "+",
                content: strip(additions[Number(group.additionLineIndex ?? 0) + index]),
                lang,
              })
              hasContent = true
            }
          }
        }
      }
    }
  if (!hasContent) return null
  const numberWidth = Math.max(1, ...rows.flatMap((row) => ("ellipsis" in row ? [] : [String(row.number).length])))
  const chunks: Array<TextChunk> = []
  rows.forEach((row, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if ("ellipsis" in row) {
      chunks.push(fg(colors.muted)(`${indent}${".".repeat(Math.min(3, numberWidth)).padStart(numberWidth)}`))
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
