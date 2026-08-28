import type { Block } from "../schema/presentation"

export type Cell = Extract<Block, { readonly _tag: "Cell" }>

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
