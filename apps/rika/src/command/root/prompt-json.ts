import { Option, Schema } from "effect"

const JsonLine = Schema.fromJsonString(Schema.Unknown)

export const parseJsonLines = (input: string): ReadonlyArray<string> =>
  input.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return []
    const decoded = Schema.decodeUnknownOption(JsonLine)(line)
    if (Option.isNone(decoded)) throw new Error(`Invalid JSON on stdin line ${index + 1}`)
    const value = decoded.value
    if (typeof value === "string") return [value]
    if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string")
      return [value.prompt]
    throw new Error(`JSON on stdin line ${index + 1} must be a string or prompt object`)
  })
