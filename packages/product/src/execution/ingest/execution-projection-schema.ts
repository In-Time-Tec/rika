import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Schema } from "effect"

export const StreamAnchorSchema = Schema.Struct({
  streamId: Schema.String,
  patchRevision: Schema.Int,
})

export const VisibleStateSchema = Schema.Struct({
  revision: Schema.Finite,
  modelPhase: Schema.Finite,
  usableCompletionSequence: Schema.optionalKey(Schema.Finite),
})

export const TerminalStatusSchema = Schema.Literals(["completed", "failed", "cancelled"])

export const ProjectionOriginSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Discovery"), executionId: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("Event"),
    executionId: Schema.String,
    cursor: Schema.String,
    sequence: Schema.Int,
    type: Schema.String,
    createdAt: Schema.Finite,
    transient: Schema.Boolean,
    text: Schema.optionalKey(Schema.String),
    blockId: Schema.optionalKey(Schema.String),
    steeringSequences: Schema.optionalKey(Schema.Array(Schema.Int)),
  }),
  Schema.Struct({ _tag: Schema.tag("RecordedShell"), phase: Schema.Literal("settled") }),
])

export const SnapshotSchema = Schema.Struct({
  threadId: Thread.ThreadId,
  rootTurnId: Turn.TurnId,
  turn: Turn.Turn,
  ...StreamAnchorSchema.fields,
  state: VisibleStateSchema,
  units: Schema.Array(TranscriptUnit.Unit),
  rootStatus: Schema.optionalKey(TerminalStatusSchema),
})

export const PatchSchema = Schema.Struct({
  threadId: Thread.ThreadId,
  rootTurnId: Turn.TurnId,
  turn: Schema.optionalKey(Turn.Turn),
  streamId: Schema.String,
  baseRevision: Schema.Int,
  patchRevision: Schema.Int,
  origin: ProjectionOriginSchema,
  state: VisibleStateSchema,
  delta: Schema.Struct({
    upsert: Schema.Array(TranscriptUnit.Unit),
    remove: Schema.Array(Schema.String),
  }),
  rootStatus: Schema.optionalKey(TerminalStatusSchema),
})
