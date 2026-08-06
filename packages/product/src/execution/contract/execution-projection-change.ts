import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Schema } from "effect"
import { Checkpoint, limits } from "./execution-projection-checkpoint"
import { ProjectionState } from "./execution-projection-state"

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Snapshot = Schema.TaggedStruct("ProjectionSnapshot", {
  revision: Revision,
  checkpoint: Schema.optionalKey(Checkpoint),
  units: Schema.Array(TranscriptUnit.Unit).check(Schema.isMaxLength(limits.snapshotUnits)),
  hasOlder: Schema.Boolean,
  state: ProjectionState,
})
export type Snapshot = typeof Snapshot.Type

export const Patch = Schema.TaggedStruct("ProjectionPatch", {
  baseRevision: Revision,
  revision: Revision,
  checkpoint: Checkpoint,
  upsert: Schema.Array(TranscriptUnit.Unit).check(Schema.isMaxLength(limits.patchUnits)),
  remove: Schema.Array(Schema.String).check(Schema.isMaxLength(limits.patchUnits)),
  state: ProjectionState,
})
export type Patch = typeof Patch.Type

export const Change = Schema.Union([Snapshot, Patch])
export type Change = typeof Change.Type

export interface Result {
  readonly turnId: string
  readonly status: ProjectionState["status"]
  readonly state: ProjectionState
  readonly units: ReadonlyArray<TranscriptUnit.Unit>
  readonly changes: ReadonlyArray<Change>
  readonly checkpoint?: Checkpoint
}
