import { Function } from "effect"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Thread from "@rika/product/thread-record"

export type SelectionEpochState = {
  readonly epoch: number
  readonly thread: Thread.Thread
  transcriptCursor: TranscriptPage.PageCursor | undefined
  newestTranscriptCursor: TranscriptPage.PageCursor | undefined
  hasOlder: boolean
}

const makeSelectionStateImpl = (thread: Thread.Thread, epoch: number): SelectionEpochState => ({
  epoch,
  thread,
  transcriptCursor: undefined,
  newestTranscriptCursor: undefined,
  hasOlder: false,
})

export const makeSelectionState: {
  (arg1: number): (arg0: Thread.Thread) => ReturnType<typeof makeSelectionStateImpl>
  (arg0: Thread.Thread, arg1: number): ReturnType<typeof makeSelectionStateImpl>
} = Function.dual(2, makeSelectionStateImpl)

const isNewerSelectionEpochImpl = (requested: number, current: number): boolean => requested > current

export const isNewerSelectionEpoch: {
  (arg1: number): (arg0: number) => ReturnType<typeof isNewerSelectionEpochImpl>
  (arg0: number, arg1: number): ReturnType<typeof isNewerSelectionEpochImpl>
} = Function.dual(2, isNewerSelectionEpochImpl)

const selectionMatchesImpl = (
  state: SelectionEpochState | undefined,
  threadId: Thread.ThreadId | string,
  epoch: number,
): state is SelectionEpochState =>
  state !== undefined && String(state.thread.id) === String(threadId) && state.epoch === epoch

export const selectionMatches: {
  (
    arg1: Thread.ThreadId | string,
    arg2: number,
  ): (arg0: SelectionEpochState | undefined) => ReturnType<typeof selectionMatchesImpl>
  (
    arg0: SelectionEpochState | undefined,
    arg1: Thread.ThreadId | string,
    arg2: number,
  ): ReturnType<typeof selectionMatchesImpl>
} = Function.dual(3, selectionMatchesImpl)

export const selectionThreadId = (state: SelectionEpochState | undefined): string | undefined =>
  state === undefined ? undefined : String(state.thread.id)
