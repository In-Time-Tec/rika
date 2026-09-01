import { Schema } from "effect"

const indent = (value: string, depth: number): string => value.replaceAll("\n", `\n${"  ".repeat(depth)}`)

const formatValue = (value: Schema.Json, depth: number): string => {
  if (value === null || Schema.is(Schema.Boolean)(value) || Schema.is(Schema.Finite)(value)) return String(value)
  if (Schema.is(Schema.String)(value)) return value.includes("\n") ? value : JSON.stringify(value)
  if (Schema.is(Schema.Array(Schema.Json))(value)) {
    if (value.length === 0) return "[]"
    return `[\n${value.map((item) => `${"  ".repeat(depth + 1)}${indent(formatValue(item, depth + 1), depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"
  return `{\n${entries
    .map(
      ([key, item]) =>
        `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: ${indent(formatValue(item, depth + 1), depth + 1)}`,
    )
    .join(",\n")}\n${"  ".repeat(depth)}}`
}

export const formatResult = (value: Schema.Json): string => formatValue(value, 0)
