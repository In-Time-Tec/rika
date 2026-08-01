import { Schema } from "effect"

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
