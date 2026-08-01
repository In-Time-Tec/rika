import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Schema } from "effect"
import { Turn, TurnId } from "./turn-record"
import type { AgentExecutionTurn } from "./turn-record"
import { ExecutionAttachment } from "./thread-result"

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

export const ExecutionCheckpoint = Schema.Struct({
  executionKey: Schema.String,
  executionId: Schema.String,
  cursor: Schema.String,
  sequence: Schema.Finite,
  status: Schema.optionalKey(Schema.Literals(["completed", "failed", "cancelled"])),
  state: TranscriptProjectionModel.ProjectionState,
  attachment: Schema.optionalKey(ExecutionAttachment),
})
export interface ExecutionCheckpoint extends Schema.Schema.Type<typeof ExecutionCheckpoint> {}

export interface Projection {
  readonly turn: Turn
  readonly units: ReadonlyArray<TranscriptUnit.Unit>
  readonly checkpointGeneration: number
  readonly revision: number
  readonly modelPhase: number
  readonly usableCompletionSequence: number | undefined
  readonly oldestCursor: string | undefined
  readonly checkpointCursor: string | undefined
  readonly costUsd: number | undefined
  readonly usageCursors: ReadonlyArray<string> | undefined
  readonly pricingVersion: string | undefined
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly hasNewer?: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor?: PageCursor | undefined
  readonly threadCostUsd: number
}

export type RefoldWriteResult =
  | { readonly _tag: "Committed"; readonly turn: AgentExecutionTurn }
  | { readonly _tag: "Stale" }
