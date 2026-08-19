import { Schema } from "effect"

export const SteeringTextMaxCharacters = 4_096
export const PendingSteeringMaxEntries = 64

export const SteeringInput = Schema.Struct({
  text: Schema.String,
  idempotencyKey: Schema.String,
})
export type SteeringInput = typeof SteeringInput.Type

export const SteeringReceipt = Schema.Struct({
  entryId: Schema.String,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type SteeringReceipt = typeof SteeringReceipt.Type
