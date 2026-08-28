import type { Block } from "../schema/presentation"
import { Schema } from "effect"

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

const indent = (value: string, depth: number): string => value.replaceAll("\n", `\n${"  ".repeat(depth)}`)

const formatResult = (value: Schema.Json, depth: number): string => {
  if (value === null || Schema.is(Schema.Boolean)(value) || Schema.is(Schema.Finite)(value)) return String(value)
  if (Schema.is(Schema.String)(value)) return value.includes("\n") ? value : JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return `[\n${value.map((item) => `${"  ".repeat(depth + 1)}${indent(formatResult(item, depth + 1), depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"
  return `{\n${entries
    .map(
      ([key, item]) =>
        `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: ${indent(formatResult(item, depth + 1), depth + 1)}`,
    )
    .join(",\n")}\n${"  ".repeat(depth)}}`
}

export const formatCellResult = (value: Schema.Json): string => formatResult(value, 0)

export const cellBodyText = (cell: Cell): string =>
  [
    cell.source.text,
    cell.output.stdout,
    cell.output.stderr,
    cell.result === undefined ? "" : formatCellResult(cell.result),
    cell.error === undefined ? "" : `${cell.error.name}: ${cell.error.message}\n${cell.error.stack ?? ""}`,
    ...cell.notices.map((notice) => notice.detail),
    ...cell.calls.flatMap((call) => [call.inputSummary, call.message ?? ""]),
  ]
    .filter((part) => part.length > 0)
    .join("\n")
