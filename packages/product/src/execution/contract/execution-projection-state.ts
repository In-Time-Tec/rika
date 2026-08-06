import { Schema } from "effect"
import { UsageState } from "./execution-usage-state"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const GeneratedTitle = Schema.Struct({
  text: Schema.String,
})
export type GeneratedTitle = typeof GeneratedTitle.Type

export const SteeringSummary = Schema.Struct({
  steeringMessages: Count,
  followUpMessages: Count,
})
export type SteeringSummary = typeof SteeringSummary.Type

export const ProjectionState = Schema.Struct({
  status: Schema.Literals(["running", "waiting", "cancelling", "completed", "failed", "cancelled"]),
  usage: UsageState,
  title: Schema.optionalKey(GeneratedTitle),
  steering: SteeringSummary,
})
export type ProjectionState = typeof ProjectionState.Type
