import { Schema } from "effect"
import { TokenTotals, addOptional, sumTokenTotals } from "./execution-token-totals"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const ContextReading = Schema.Struct({
  requestOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  purpose: Schema.Literal("conversation"),
  inputTokens: Count,
})
export type ContextReading = typeof ContextReading.Type

export const ActiveTime = Schema.Union([
  Schema.TaggedStruct("Unavailable", {}),
  Schema.TaggedStruct("Available", {
    accumulatedMillis: NonNegative,
    activeSince: Schema.optionalKey(Schema.Finite),
  }),
])
export type ActiveTime = typeof ActiveTime.Type

export const UsageState = Schema.Struct({
  costNanoUsd: Schema.optionalKey(Count),
  tokens: Schema.optionalKey(TokenTotals),
  pricedAttempts: Count,
  unpricedAttempts: Count,
  countedAttempts: Count,
  uncountedAttempts: Count,
  sourceComplete: Schema.Boolean,
  context: Schema.optionalKey(ContextReading),
  contextPending: Schema.Boolean,
  active: ActiveTime,
})
export type UsageState = typeof UsageState.Type

export const emptyUsageState = (): UsageState => ({
  pricedAttempts: 0,
  unpricedAttempts: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
  sourceComplete: false,
  contextPending: false,
  active: { _tag: "Unavailable" },
})

export const aggregateUsage = (values: ReadonlyArray<UsageState>): UsageState => {
  if (values.length === 0) return emptyUsageState()
  const pricedAttempts = values.reduce((total, value) => total + value.pricedAttempts, 0)
  const costNanoUsd = addOptional(values.map((value) => value.costNanoUsd))
  const availableActive = values.flatMap((value) => (value.active._tag === "Available" ? [value.active] : []))
  const context = values.toReversed().find((value) => value.context !== undefined)?.context
  return {
    ...(pricedAttempts === 0 || costNanoUsd === undefined ? {} : { costNanoUsd }),
    ...(sumTokenTotals(values.map((value) => value.tokens)) === undefined
      ? {}
      : { tokens: sumTokenTotals(values.map((value) => value.tokens))! }),
    pricedAttempts,
    unpricedAttempts: values.reduce((total, value) => total + value.unpricedAttempts, 0),
    countedAttempts: values.reduce((total, value) => total + value.countedAttempts, 0),
    uncountedAttempts: values.reduce((total, value) => total + value.uncountedAttempts, 0),
    sourceComplete: values.every((value) => value.sourceComplete),
    ...(context === undefined ? {} : { context }),
    contextPending: values.at(-1)?.contextPending ?? false,
    active:
      availableActive.length === 0
        ? { _tag: "Unavailable" }
        : {
            _tag: "Available",
            accumulatedMillis: availableActive.reduce((total, value) => total + value.accumulatedMillis, 0),
            ...(availableActive.some((value) => value.activeSince !== undefined)
              ? {
                  activeSince: Math.min(
                    ...availableActive.flatMap((value) => (value.activeSince === undefined ? [] : [value.activeSince])),
                  ),
                }
              : {}),
          },
  }
}
