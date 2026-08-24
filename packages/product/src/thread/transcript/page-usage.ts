import { Schema } from "effect"
import * as ExecutionProjection from "../../execution/projection/contract"

export const ContextCapacity = Schema.Struct({
  contextWindow: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  reserveTokens: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ContextCapacity = typeof ContextCapacity.Type

export const UsageSummary = Schema.Struct({
  usage: ExecutionProjection.UsageState,
  contextCapacity: Schema.optionalKey(ContextCapacity),
})
export type UsageSummary = typeof UsageSummary.Type
