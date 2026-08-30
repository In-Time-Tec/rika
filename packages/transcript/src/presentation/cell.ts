import type { Block } from "../schema/presentation"
import { Schema } from "effect"

export type Cell = Extract<Block, { readonly _tag: "Cell" }>

const indent = (value: string, depth: number): string => value.replaceAll("\n", `\n${"  ".repeat(depth)}`)

const formatResult = (value: Schema.Json, depth: number): string => {
  if (value === null || Schema.is(Schema.Boolean)(value) || Schema.is(Schema.Finite)(value)) return String(value)
  if (Schema.is(Schema.String)(value)) return value.includes("\n") ? value : JSON.stringify(value)
  if (Schema.is(Schema.Array(Schema.Json))(value)) {
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
