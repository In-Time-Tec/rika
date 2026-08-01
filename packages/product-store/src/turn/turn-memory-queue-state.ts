import { ThreadId } from "@rika/product/thread-record"
import type { MemoryQueueState, MemoryState } from "./turn-memory-state"

export const emptyQueueState: MemoryQueueState = {
  revision: 0,
  queuedCount: 0,
  wakeGeneration: 0,
  wakePending: false,
}

export const queueState = (state: MemoryState, threadId: ThreadId): MemoryQueueState =>
  state.queues.get(threadId) ?? emptyQueueState

export const withQueueState = (state: MemoryState, threadId: ThreadId, queue: MemoryQueueState): MemoryState => ({
  ...state,
  queues: new Map(state.queues).set(threadId, queue),
})
