import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as Transcript from "@rika/transcript/transcript-presentation-model"
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
  Schema.Struct({
    _tag: Schema.tag("Discovery"),
    executionId: Schema.String,
  }),
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
  Schema.Struct({
    _tag: Schema.tag("RecordedShell"),
    phase: Schema.Literal("settled"),
  }),
])

export const SnapshotSchema = Schema.Struct({
  threadId: Thread.ThreadId,
  rootTurnId: Turn.TurnId,
  turn: Turn.Turn,
  ...StreamAnchorSchema.fields,
  state: VisibleStateSchema,
  units: Schema.Array(Transcript.Unit),
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
    upsert: Schema.Array(Transcript.Unit),
    remove: Schema.Array(Schema.String),
  }),
  rootStatus: Schema.optionalKey(TerminalStatusSchema),
})

export type Unit = Transcript.Unit

export interface UnitDelta {
  readonly upsert: ReadonlyArray<Unit>
  readonly remove: ReadonlyArray<string>
}

export interface StreamAnchor {
  readonly streamId: string
  readonly patchRevision: number
}

export interface VisibleState {
  readonly revision: number
  readonly modelPhase: number
  readonly usableCompletionSequence?: number
}

export type TerminalStatus = "completed" | "failed" | "cancelled"

export type ProjectionOrigin =
  | {
      readonly _tag: "Discovery"
      readonly executionId: string
    }
  | {
      readonly _tag: "Event"
      readonly executionId: string
      readonly cursor: string
      readonly sequence: number
      readonly type: string
      readonly createdAt: number
      readonly transient: boolean
      readonly text?: string
      readonly blockId?: string
      readonly steeringSequences?: ReadonlyArray<number>
    }
  | {
      readonly _tag: "RecordedShell"
      readonly phase: "settled"
    }

export interface Snapshot extends StreamAnchor {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly turn: Turn.Turn
  readonly state: VisibleState
  readonly units: ReadonlyArray<Unit>
  readonly rootStatus?: TerminalStatus
}

export interface Patch {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly turn?: Turn.Turn
  readonly streamId: string
  readonly baseRevision: number
  readonly patchRevision: number
  readonly origin: ProjectionOrigin
  readonly state: VisibleState
  readonly delta: UnitDelta
  readonly rootStatus?: TerminalStatus
}

export type Change =
  | { readonly _tag: "ProjectionStarted"; readonly snapshot: Snapshot }
  | { readonly _tag: "ProjectionPatched"; readonly patch: Patch }
  | {
      readonly _tag: "ProjectionStopped"
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly streamId: string
      readonly patchRevision: number
      readonly status: TerminalStatus
    }
