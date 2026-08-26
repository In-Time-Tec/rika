import { Schema } from "effect"
import { UsageState } from "../usage/state"
import { SteeringSummary } from "../session/pending-steering"

export const GeneratedTitle = Schema.Struct({
  text: Schema.String,
})
export type GeneratedTitle = typeof GeneratedTitle.Type

export const ProjectionState = Schema.Struct({
  status: Schema.Literals(["running", "waiting", "cancelling", "completed", "failed", "cancelled"]),
  usage: UsageState,
  title: Schema.optionalKey(GeneratedTitle),
  steering: SteeringSummary,
})
export type ProjectionState = typeof ProjectionState.Type
