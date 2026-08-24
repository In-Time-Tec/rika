import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Schema } from "effect"
import * as Thread from "../model/record"
import * as Turn from "../turn/record"
import { duplicateKey, limits, ThreadViewSource } from "./limits"
import { ThreadViewPendingTurn, ThreadViewTurn, ThreadViewTurnRecord, ThreadViewUsage } from "./turn"

const NonNegativeRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const headerFields = {
  thread: Thread.Thread,
  source: ThreadViewSource,
  pending: Schema.Array(ThreadViewPendingTurn).check(Schema.isMaxLength(limits.pending)),
  hasOlder: Schema.Boolean,
  hasNewer: Schema.Boolean,
  usage: ThreadViewUsage,
} as const

export const ThreadViewHeader = Schema.Struct(headerFields)
export type ThreadViewHeader = typeof ThreadViewHeader.Type

const ThreadViewSnapshotStruct = Schema.Struct({
  ...headerFields,
  revision: NonNegativeRevision,
  turns: Schema.Array(ThreadViewTurn),
})

export const ThreadViewSnapshot = ThreadViewSnapshotStruct.check(
  Schema.makeFilter((snapshot) => {
    const issues: Array<Schema.FilterIssue> = []
    const threadId = String(snapshot.thread.id)
    const turnIds = snapshot.turns.map((entry) => String(entry.turn.id))
    const duplicateTurn = duplicateKey(turnIds)
    if (duplicateTurn !== undefined) issues.push({ path: ["turns"], issue: `duplicate Turn ${duplicateTurn}` })
    const units = snapshot.turns.flatMap((entry) => entry.units)
    const duplicateUnit = duplicateKey(units.map((unit) => unit.key))
    if (duplicateUnit !== undefined) issues.push({ path: ["turns"], issue: `duplicate timeline item ${duplicateUnit}` })
    for (const entry of snapshot.turns) {
      if (String(entry.turn.threadId) !== threadId)
        issues.push({ path: ["turns"], issue: `Turn ${entry.turn.id} belongs to another Thread` })
      for (const unit of entry.units)
        if (unit.turnId !== String(entry.turn.id))
          issues.push({ path: ["turns"], issue: `timeline item ${unit.key} belongs to another Turn` })
    }
    const duplicatePending = duplicateKey(snapshot.pending.map((pending) => String(pending.id)))
    if (duplicatePending !== undefined)
      issues.push({ path: ["pending"], issue: `duplicate pending Turn ${duplicatePending}` })
    return issues
  }),
)
export type ThreadViewSnapshot = typeof ThreadViewSnapshot.Type

export const ThreadViewTurnChange = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("UpsertTurn"),
    turn: ThreadViewTurnRecord,
    projectionRevision: NonNegativeRevision,
    usage: ExecutionProjection.UsageState,
    pendingSteering: Schema.optionalKey(
      Schema.Array(ExecutionProjection.PendingSteering).check(
        Schema.isMaxLength(ExecutionProjection.PendingSteeringMaxEntries),
      ),
    ),
    settledSteering: Schema.optionalKey(
      Schema.Array(ExecutionProjection.SteeringDisposition).check(
        Schema.isMaxLength(ExecutionProjection.PendingSteeringMaxEntries),
      ),
    ),
  }),
  Schema.Struct({
    _tag: Schema.tag("RemoveTurn"),
    turnId: Turn.TurnId,
  }),
])
export type ThreadViewTurnChange = typeof ThreadViewTurnChange.Type

export const ThreadViewPatch = Schema.Struct({
  threadId: Thread.ThreadId,
  baseRevision: NonNegativeRevision,
  revision: NonNegativeRevision,
  upsert: Schema.Array(TranscriptUnit.Unit).check(Schema.isMaxLength(limits.patchItems)),
  remove: Schema.Array(Schema.String).check(Schema.isMaxLength(limits.patchItems)),
  turnChanges: Schema.Array(ThreadViewTurnChange).check(Schema.isMaxLength(limits.turnChanges)),
  header: Schema.optionalKey(ThreadViewHeader),
})
export type ThreadViewPatch = typeof ThreadViewPatch.Type
