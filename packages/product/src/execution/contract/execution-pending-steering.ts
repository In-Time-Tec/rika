import { Function, Schema } from "effect"
import { identityKey } from "@rika/transcript/transcript-unit-identity"
import { PendingSteeringMaxEntries } from "./execution-steering"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const PendingSteering = Schema.Struct({
  runId: Schema.String,
  entryId: Schema.String,
  requestId: Schema.String,
  sequence: Count,
  text: Schema.String,
})
export type PendingSteering = typeof PendingSteering.Type

export const SteeringDisposition = Schema.Struct({
  runId: Schema.String,
  entryId: Schema.String,
  requestId: Schema.String,
  sequence: Count,
  outcome: Schema.Literals(["consumed", "discarded"]),
})
export type SteeringDisposition = typeof SteeringDisposition.Type

export const SteeringSummary = Schema.Struct({
  steeringMessages: Count,
  followUpMessages: Count,
  pending: Schema.optionalKey(Schema.Array(PendingSteering).check(Schema.isMaxLength(PendingSteeringMaxEntries))),
  settled: Schema.optionalKey(Schema.Array(SteeringDisposition).check(Schema.isMaxLength(PendingSteeringMaxEntries))),
})
export type SteeringSummary = typeof SteeringSummary.Type

export const steeringUnitKeyPrefix: {
  (requestId: string): (turnId: string) => string
  (turnId: string, requestId: string): string
} = Function.dual(2, (turnId: string, requestId: string): string => identityKey("turn", turnId, "steering", requestId))

export const steeringUnitKey: {
  (runId: string, requestId: string, entryId: string, sequence: number): (turnId: string) => string
  (turnId: string, runId: string, requestId: string, entryId: string, sequence: number): string
} = Function.dual(5, (turnId: string, runId: string, requestId: string, entryId: string, sequence: number): string =>
  identityKey("turn", turnId, "steering", requestId, runId, entryId, sequence),
)
