import { Schema } from "effect"

export const projectionVersion = 2 as const

export const limits = {
  snapshotUnits: 120,
  patchUnits: 128,
  inFlightAttempts: 256,
  settledAttemptKeys: 256,
  modelCalls: 256,
} as const

export const Checkpoint = Schema.Struct({
  version: Schema.Literal(projectionVersion),
  cursor: Schema.String,
  state: Schema.String.check(Schema.isMaxLength(1_000_000)),
})
export type Checkpoint = typeof Checkpoint.Type
