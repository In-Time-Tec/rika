import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"

export interface UnitDelta {
  readonly upsert: ReadonlyArray<TranscriptUnit.Unit>
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
  readonly units: ReadonlyArray<TranscriptUnit.Unit>
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
