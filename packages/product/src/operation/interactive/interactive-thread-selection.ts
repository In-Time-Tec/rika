import * as Thread from "@rika/product/thread-record"
import type { SelectionEpochState } from "../dispatch/execution-operation-coordination"

export const isNewerSelectionEpoch = (requested: number, current: number): boolean => requested > current

export const selectionMatches = (
  state: SelectionEpochState | undefined,
  threadId: Thread.ThreadId | string,
  epoch: number,
): state is SelectionEpochState =>
  state !== undefined && String(state.thread.id) === String(threadId) && state.epoch === epoch

export const selectionThreadId = (state: SelectionEpochState | undefined): string | undefined =>
  state === undefined ? undefined : String(state.thread.id)
