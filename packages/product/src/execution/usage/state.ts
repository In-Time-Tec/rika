import { Schema } from "effect"
import { TokenTotals, addOptional, sumTokenTotals } from "./token-totals"

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
  includedAttempts: Schema.optionalKey(Count),
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
  includedAttempts: 0,
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
  const tokens = sumTokenTotals(values.map((value) => value.tokens))
  const availableActive = values.flatMap((value) => (value.active._tag === "Available" ? [value.active] : []))
  const context = values.toReversed().find((value) => value.context !== undefined)?.context
  let active: UsageState["active"] = { _tag: "Unavailable" }
  if (availableActive.length > 0) {
    const accumulatedMillis = availableActive.reduce((total, value) => total + value.accumulatedMillis, 0)
    const activeSince = availableActive.flatMap((value) =>
      value.activeSince === undefined ? [] : [value.activeSince],
    )
    active =
      activeSince.length === 0
        ? { _tag: "Available", accumulatedMillis }
        : { _tag: "Available", accumulatedMillis, activeSince: Math.min(...activeSince) }
  }
  let aggregate: UsageState = {
    pricedAttempts,
    unpricedAttempts: values.reduce((total, value) => total + value.unpricedAttempts, 0),
    includedAttempts: values.reduce((total, value) => total + (value.includedAttempts ?? 0), 0),
    countedAttempts: values.reduce((total, value) => total + value.countedAttempts, 0),
    uncountedAttempts: values.reduce((total, value) => total + value.uncountedAttempts, 0),
    sourceComplete: values.every((value) => value.sourceComplete),
    contextPending: values.at(-1)?.contextPending ?? false,
    active,
  }
  if (pricedAttempts > 0 && costNanoUsd !== undefined) aggregate = { ...aggregate, costNanoUsd }
  if (tokens !== undefined) aggregate = { ...aggregate, tokens }
  if (context !== undefined) aggregate = { ...aggregate, context }
  return aggregate
}
