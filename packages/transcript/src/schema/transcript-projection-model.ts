import { Schema } from "effect"
import { Unit } from "./transcript-unit"

const ProjectionStateFields = {
  revision: Schema.Finite,
  modelPhase: Schema.Finite,
  usableCompletionSequence: Schema.optionalKey(Schema.Finite),
  oldestCursor: Schema.optionalKey(Schema.String),
  checkpointCursor: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
  usageCursors: Schema.optionalKey(Schema.Array(Schema.String)),
  pricingVersion: Schema.optionalKey(Schema.String),
} as const

export const ProjectionState = Schema.Struct(ProjectionStateFields)
export type ProjectionState = typeof ProjectionState.Type

export const Projection = Schema.Struct({
  units: Schema.Array(Unit),
  ...ProjectionStateFields,
})
export type Projection = typeof Projection.Type
