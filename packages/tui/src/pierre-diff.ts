import { StyledText, fg, type TextChunk } from "@opentui/core"
import { parsePatchFiles } from "@pierre/diffs"
import { Function } from "effect"
import { colors } from "./theme"

const clip = (text: string, width: number): string =>
  text.length <= width ? text : width <= 1 ? "…" : `${text.slice(0, width - 1)}…`

const strip = (line: string | undefined): string => (line ?? "").replace(/\r?\n$/, "")

const hunkStarts = (spec: string): { readonly oldStart: number; readonly newStart: number } => {
  const match = /-(\d+)(?:,\d+)? \+(\d+)/.exec(spec)
  return { oldStart: Number(match?.[1] ?? 1), newStart: Number(match?.[2] ?? 1) }
}

type Row =
  | { readonly ellipsis: true }
  | { readonly number: number; readonly marker: " " | "+" | "-"; readonly content: string }

export const renderPierreDiff: {
  (width: number): (patch: string) => StyledText | undefined
  (patch: string, width: number): StyledText | undefined
} = Function.dual(2, (patch: string, width: number): StyledText | undefined => {
  let parsed: ReturnType<typeof parsePatchFiles>
  try {
    parsed = parsePatchFiles(patch)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  const rows: Array<Row> = []
  let hasContent = false
  for (const result of parsed as ReadonlyArray<{ files?: ReadonlyArray<Record<string, any>> }>)
    for (const file of result.files ?? []) {
      const additions: ReadonlyArray<string> = file.additionLines ?? []
      const deletions: ReadonlyArray<string> = file.deletionLines ?? []
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
              })
              hasContent = true
            }
          } else {
            for (let index = 0; index < Number(group.deletions ?? 0); index += 1) {
              rows.push({
                number: oldStart + Number(group.deletionLineIndex ?? 0) + index,
                marker: "-",
                content: strip(deletions[Number(group.deletionLineIndex ?? 0) + index]),
              })
              hasContent = true
            }
            for (let index = 0; index < Number(group.additions ?? 0); index += 1) {
              rows.push({
                number: newStart + Number(group.additionLineIndex ?? 0) + index,
                marker: "+",
                content: strip(additions[Number(group.additionLineIndex ?? 0) + index]),
              })
              hasContent = true
            }
          }
        }
      }
    }
  if (!hasContent) return undefined
  const numberWidth = Math.max(1, ...rows.flatMap((row) => ("ellipsis" in row ? [] : [String(row.number).length])))
  const chunks: Array<TextChunk> = []
  rows.forEach((row, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if ("ellipsis" in row) {
      chunks.push(fg(colors.muted)(`${" ".repeat(numberWidth - 1)}...`))
      return
    }
    const prefix = `${String(row.number).padStart(numberWidth)} ${row.marker} `
    const color = row.marker === "+" ? colors.green : row.marker === "-" ? colors.red : colors.muted
    chunks.push(fg(color)(`${prefix}${clip(row.content, Math.max(1, width - prefix.length))}`))
  })
  return new StyledText(chunks)
})
