import { Schema } from "effect"
import { Unit } from "./transcript-unit"

export const ModelFailure = Schema.Struct({
  modelCallId: Schema.String,
  category: Schema.String,
  classification: Schema.String,
  purpose: Schema.optionalKey(Schema.String),
  attempts: Schema.optionalKey(Schema.Finite),
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
})
export type ModelFailure = typeof ModelFailure.Type

const ProjectionStateFields = {
  revision: Schema.Finite,
  modelPhase: Schema.Finite,
  usableCompletionSequence: Schema.optionalKey(Schema.Finite),
  oldestCursor: Schema.optionalKey(Schema.String),
  checkpointCursor: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
  usageCursors: Schema.optionalKey(Schema.Array(Schema.String)),
  pricingVersion: Schema.optionalKey(Schema.String),
  modelFailure: Schema.optionalKey(ModelFailure),
} as const

export const ProjectionState = Schema.Struct(ProjectionStateFields)
export type ProjectionState = typeof ProjectionState.Type

export const Projection = Schema.Struct({
  units: Schema.Array(Unit),
  ...ProjectionStateFields,
})
export type Projection = typeof Projection.Type
