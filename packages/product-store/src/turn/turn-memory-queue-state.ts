import { ThreadId } from "@rika/product/thread-record"
import type { MemoryQueueState, MemoryState } from "./turn-memory-state"

export const emptyQueueState: MemoryQueueState = {
  revision: 0,
  queuedCount: 0,
  wakeGeneration: 0,
  wakePending: false,
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

export function withQueueState(threadId: ThreadId, queue: MemoryQueueState): (state: MemoryState) => MemoryState
export function withQueueState(state: MemoryState, threadId: ThreadId, queue: MemoryQueueState): MemoryState
export function withQueueState(
  stateOrThreadId: MemoryState | ThreadId,
  threadIdOrQueue?: ThreadId | MemoryQueueState,
  queue?: MemoryQueueState,
): MemoryState | ((state: MemoryState) => MemoryState) {
  if (queue === undefined) {
    if (typeof stateOrThreadId !== "string" || threadIdOrQueue === undefined || typeof threadIdOrQueue === "string")
      throw new Error("Invalid queue state arguments")
    return (state) => withQueueState(state, stateOrThreadId, threadIdOrQueue)
  }
  if (typeof stateOrThreadId === "string" || threadIdOrQueue === undefined || typeof threadIdOrQueue !== "string")
    throw new Error("Invalid queue state arguments")
  return {
    ...stateOrThreadId,
    queues: new Map(stateOrThreadId.queues).set(threadIdOrQueue, queue),
  }
}
