import type { Block } from "../schema/transcript-presentation-model"

export type Cell = Extract<Block, { readonly _tag: "Cell" }>

const shellStatement = /Bun\.(?:\$`|spawn(?:Sync)?\s*\()/u
const commentOnly = /^(?:\/\/|\/\*|\*)/u

export const meaningfulSourceLines = (source: string): ReadonlyArray<string> =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !commentOnly.test(line))

export const cellSourceLineCount = (source: string): number => (source.length === 0 ? 0 : source.split("\n").length)

export const cellSummary = (source: string): string => meaningfulSourceLines(source)[0] ?? ""

export const cellVisual = (source: string): Cell["visual"] => {
  const lines = meaningfulSourceLines(source)
  return lines.length === 1 && shellStatement.test(lines[0]!) ? "shell" : "ts"
}

export const cellGlyph = (visual: Cell["visual"]): string => (visual === "shell" ? "$" : "ts")

export const formatCellDuration = (millis: number): string => {
  if (!Number.isFinite(millis) || millis < 0) return ""
  if (millis < 1_000) return `${Math.round(millis)}ms`
  const seconds = millis / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

export const cellOutputTruncated = (cell: Cell): boolean =>
  cell.source.truncated || cell.output.droppedBytes > 0 || cell.output.droppedEvents > 0

export const cellCollapsedLine = (cell: Cell): string => {
  const parts = [cellGlyph(cell.visual)]
  if (cell.summary.length > 0) parts.push(cell.summary)
  const details: Array<string> = []
  if (cell.source.lines > 0) details.push(`${cell.source.lines} ${cell.source.lines === 1 ? "line" : "lines"}`)
  const duration = cell.durationMillis === undefined ? "" : formatCellDuration(cell.durationMillis)
  if (duration.length > 0) details.push(duration)
  if (cellOutputTruncated(cell)) details.push("truncated")
  return [parts.join(" "), ...details].join(" · ")
}

export const cellBodyText = (cell: Cell): string =>
  [
    cell.source.text,
    cell.output.stdout,
    cell.output.stderr,
    cell.result ?? "",
    cell.error === undefined ? "" : `${cell.error.name}: ${cell.error.message}\n${cell.error.stack ?? ""}`,
    ...cell.notices.map((notice) => notice.detail),
  ]
    .filter((part) => part.length > 0)
    .join("\n")
