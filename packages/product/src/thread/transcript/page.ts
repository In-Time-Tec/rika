import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Turn } from "../turn/record"
import * as ExecutionProjection from "../../execution/projection/contract"
import type { Entry, PageCursor } from "./page-entry"
import type { UsageSummary } from "./page-usage"

export * from "./page-entry"
export * from "./page-usage"

export const maximumTranscriptUnits = 20_000

export interface Projection {
  readonly turn: Turn
  readonly units: ReadonlyArray<TranscriptUnit.Unit>
  readonly checkpointGeneration: number
  readonly revision: number
  readonly state: ExecutionProjection.ProjectionState
  readonly projectorCheckpoint?: ExecutionProjection.Checkpoint
  readonly projectionVersion: number
}

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor: PageCursor | undefined
  readonly usage: UsageSummary
}
