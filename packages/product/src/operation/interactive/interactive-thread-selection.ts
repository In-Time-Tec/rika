import * as TranscriptPage from "@rika/product/transcript-page"
import * as Thread from "@rika/product/thread-record"
import type { ProjectionWatch } from "../../execution/ingest/execution-ingest-watch"
import type { Scope } from "effect"

export type SelectionEpochState = {
  readonly epoch: number
  readonly thread: Thread.Thread
  readonly loadedKeys: Set<string>
  transcriptCursor: TranscriptPage.PageCursor | undefined
  newestTranscriptCursor: TranscriptPage.PageCursor | undefined
  hasOlder: boolean
  projectionFeed?: {
    readonly watch: ProjectionWatch
    readonly scope: Scope.Closeable
    promoted: boolean
  }
}

export const makeSelectionState = (thread: Thread.Thread, epoch: number): SelectionEpochState => ({
  epoch,
  thread,
  loadedKeys: new Set(),
  transcriptCursor: undefined,
  newestTranscriptCursor: undefined,
  hasOlder: false,
})

export const isNewerSelectionEpoch = (requested: number, current: number): boolean => requested > current

export const selectionMatches = (
  state: SelectionEpochState | undefined,
  threadId: Thread.ThreadId | string,
  epoch: number,
): state is SelectionEpochState =>
  state !== undefined && String(state.thread.id) === String(threadId) && state.epoch === epoch

export const selectionThreadId = (state: SelectionEpochState | undefined): string | undefined =>
  state === undefined ? undefined : String(state.thread.id)
