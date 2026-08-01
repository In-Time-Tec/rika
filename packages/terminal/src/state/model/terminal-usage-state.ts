import { Schema } from "effect"

export const formatContextTokens = (tokens: number): string => {
  if (tokens < 1_000) return tokens.toLocaleString("en-US")
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1).replace(/\.0$/, "")}K`
  return `${(tokens / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`
}

export const UsageTime = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Loading") }),
  Schema.Struct({ _tag: Schema.tag("Unavailable") }),
  Schema.Struct({
    _tag: Schema.tag("Available"),
    accumulatedMillis: Schema.Finite,
    activeSince: Schema.optionalKey(Schema.Finite),
  }),
])
export type UsageTime = typeof UsageTime.Type

export const UsageDisplay = Schema.Literals(["cost", "tokens", "time"])
export type UsageDisplay = typeof UsageDisplay.Type
