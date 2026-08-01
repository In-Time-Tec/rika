import type { ExecutionCheckpoint, PageCursor } from "../model/transcript-page"
import type { ThreadId } from "../model/thread-record"
import type { Unit } from "@rika/transcript/transcript-unit"

export interface CheckpointOptions {
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

export interface DeltaCheckpointOptions extends CheckpointOptions {
  readonly expectedGeneration: number | undefined
}

export interface UnitDelta {
  readonly upsert: ReadonlyArray<Unit>
  readonly remove: ReadonlyArray<string>
}

export interface RefoldOptions extends CheckpointOptions {
  readonly expectedProjectionVersion: number
  readonly expectedGeneration: number
}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly after?: PageCursor | undefined
  readonly limit?: number
  readonly projectionVersion?: number
}

export interface ProjectionRecoveryCandidate {
  readonly threadId: ThreadId
  readonly turnId: import("../model/turn-record").TurnId
}
