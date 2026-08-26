import { Option, Schema } from "effect"

const JsonLine = Schema.fromJsonString(Schema.Union([Schema.String, Schema.Struct({ prompt: Schema.String })]))

export const parseJsonLines = (input: string): ReadonlyArray<string> =>
  input.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return []
    const decoded = Schema.decodeOption(JsonLine)(line)
    if (Option.isNone(decoded)) throw new Error(`Invalid JSON on stdin line ${index + 1}`)
    return [Schema.is(Schema.String)(decoded.value) ? decoded.value : decoded.value.prompt]
  })
