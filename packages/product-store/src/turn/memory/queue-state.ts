import { ThreadId } from "@rika/product/thread-record"
import { Function } from "effect"
import type { MemoryQueueState, MemoryState } from "./state"

export const emptyQueueState: MemoryQueueState = {
  revision: 0,
  queuedCount: 0,
}

export function queueState(state: MemoryState): (threadId: ThreadId) => MemoryQueueState
export function queueState(state: MemoryState, threadId: ThreadId): MemoryQueueState
export function queueState(
  state: MemoryState,
  threadId?: ThreadId,
): MemoryQueueState | ((threadId: ThreadId) => MemoryQueueState) {
  if (threadId === undefined) return (nextThreadId) => queueState(state, nextThreadId)
  return state.queues.get(threadId) ?? emptyQueueState
}

const withQueueStateImpl = (state: MemoryState, threadId: ThreadId, queue: MemoryQueueState): MemoryState => ({
    ...state,
    queues: new Map(state.queues).set(threadId, queue),
  })

export const withQueueState: {
  (threadId: ThreadId, queue: MemoryQueueState): (state: MemoryState) => MemoryState
  (state: MemoryState, threadId: ThreadId, queue: MemoryQueueState): MemoryState
} = Function.dual(3, withQueueStateImpl)
