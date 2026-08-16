import { Schema } from "effect"

export const ContextUsage = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Loading") }),
  Schema.Struct({ _tag: Schema.tag("NotStarted") }),
  Schema.Struct({ _tag: Schema.tag("Unavailable") }),
  Schema.Struct({
    _tag: Schema.tag("Available"),
    inputTokens: Schema.Finite,
    inputCacheRead: Schema.Finite,
    inputTotal: Schema.Finite,
    contextWindow: Schema.Finite,
    reserveTokens: Schema.Finite,
  }),
])
export type ContextUsage = typeof ContextUsage.Type
