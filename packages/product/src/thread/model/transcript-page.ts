import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Schema } from "effect"
import { Turn, TurnId } from "./turn-record"

export interface Entry {
  readonly turn: Turn
  readonly unit: TranscriptUnit.Unit
  readonly projectionRevision: number
  readonly projectionModelPhase: number
  readonly projectionCostUsd?: number
}

export const EntrySchema = Schema.Struct({
  turn: Turn,
  unit: TranscriptUnit.Unit,
  projectionRevision: Schema.Finite,
  projectionModelPhase: Schema.Finite,
  projectionCostUsd: Schema.optionalKey(Schema.Finite),
})

export interface PageCursor {
  readonly createdAt: number
  readonly turnId: TurnId
  readonly orderKey: string
}

export const PageCursor = Schema.Struct({
  createdAt: Schema.Finite,
  turnId: TurnId,
  orderKey: Schema.NonEmptyString,
})
