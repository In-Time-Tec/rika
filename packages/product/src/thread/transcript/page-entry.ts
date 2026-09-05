import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Schema } from "effect"
import { Turn, TurnId } from "../turn/record"
import * as ExecutionProjection from "../../execution/projection/contract"

export interface Entry {
  readonly turn: Turn
  readonly unit: TranscriptUnit.Unit
  readonly projectionRevision: number
  readonly projectionGeneration?: number
  readonly projectionModelPhase: number
  readonly projectionState: ExecutionProjection.ProjectionState
}

export const EntrySchema = Schema.Struct({
  turn: Turn,
  unit: TranscriptUnit.Unit,
  projectionRevision: Schema.Finite,
  projectionModelPhase: Schema.Finite,
  projectionState: ExecutionProjection.ProjectionState,
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
