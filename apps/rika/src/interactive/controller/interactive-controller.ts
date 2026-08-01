import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Function, HashMap } from "effect"
import type { Model } from "@rika/terminal/terminal-state"
import { updateState } from "./terminal-interactive-feed"

export type TranscriptEvent = Extract<
  InteractiveEvent.InteractiveEvent,
  | { readonly _tag: "SelectionLoaded" }
  | { readonly _tag: "TranscriptPagePrepended" }
  | { readonly _tag: "TranscriptPageAppended" }
  | { readonly _tag: "TranscriptProjectionStarted" }
  | { readonly _tag: "TranscriptProjectionPatched" }
  | { readonly _tag: "TranscriptProjectionStopped" }
  | { readonly _tag: "TranscriptProjectionFailed" }
  | { readonly _tag: "TranscriptResyncRequired" }
  | { readonly _tag: "ThreadUsageUpdated" }
  | { readonly _tag: "ThreadRefolding" }
>

export interface State {
  readonly model: Model
  readonly selectionEpoch: number
  readonly replayTurns: ReadonlyMap<string, Turn.Turn>
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly revisions: ReadonlyMap<string, number>
  readonly liveProjections: ReadonlyMap<string, TranscriptProjectionModel.Projection>
  readonly projectionStreams?: ReadonlyMap<string, ProjectionStream>
  readonly threadCostUsd?: number
  readonly lastAvailableUsageCost?: Extract<Model["usageCost"], { readonly _tag: "Available" }>
  readonly usageRevision?: number
  readonly hasOlder?: boolean
  readonly hasNewer?: boolean
  readonly oldestCursor?: TranscriptPage.PageCursor | undefined
  readonly newestCursor?: TranscriptPage.PageCursor | undefined
}

interface OpenProjectionStream {
  readonly _tag: "Open"
  readonly streamId: string
  readonly patchRevision: number
  readonly state: {
    readonly revision: number
    readonly modelPhase: number
    readonly usableCompletionSequence?: number
  }
  readonly units: HashMap.HashMap<string, TranscriptUnit.Unit>
  readonly rootStatus?: "completed" | "failed" | "cancelled"
}

interface StoppedProjectionStream {
  readonly _tag: "Stopped"
  readonly streamId: string
  readonly patchRevision: number
  readonly boundary: { readonly _tag: "Stopped"; readonly status: "completed" | "failed" | "cancelled" }
}

interface FailedProjectionStream extends Omit<OpenProjectionStream, "_tag"> {
  readonly _tag: "Failed"
  readonly boundary: {
    readonly _tag: "Failed"
    readonly executionId: string
    readonly reason: string
    readonly message: string
  }
}

export type ProjectionStream = OpenProjectionStream | StoppedProjectionStream | FailedProjectionStream

export const transcriptWindowEntryBudget = 400
export const transcriptWindowByteBudget = 4 * 1024 * 1024

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
  readonly unattached?: ReadonlyArray<string>
  readonly discarded?: boolean
  readonly resync?: boolean
}

export const warnUnattached = (unattached: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.forEach(
    unattached,
    (turnId) =>
      Effect.logWarning("transcript.child.parent_missing").pipe(Effect.annotateLogs({ "rika.turn.id": turnId })),
    { discard: true },
  )

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = Function.dual(2, updateState)
