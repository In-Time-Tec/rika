import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Schema } from "effect"
import { ThreadViewTurnRecord } from "./thread-view-turn-record"

const NonNegativeRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ThreadViewUsage = Schema.Struct({
  state: ExecutionProjection.UsageState,
  contextCapacity: Schema.optionalKey(
    Schema.Struct({
      contextWindow: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      reserveTokens: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
})
export type ThreadViewUsage = typeof ThreadViewUsage.Type

export const ThreadViewTurn = Schema.Struct({
  turn: ThreadViewTurnRecord,
  units: Schema.Array(TranscriptUnit.Unit),
  projectionRevision: NonNegativeRevision,
  usage: ExecutionProjection.UsageState,
})
export type ThreadViewTurn = typeof ThreadViewTurn.Type
