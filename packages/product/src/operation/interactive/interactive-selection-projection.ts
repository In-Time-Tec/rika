import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Effect, Ref } from "effect"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { makeSelectionState, type SelectionEpochState } from "./interactive-thread-selection"
import { queueItem } from "./interactive-session-queue"

export interface InteractiveSelectionProjectionInput {
  readonly activitySequence: number
  readonly interactiveThread: Ref.Ref<Thread.Thread | undefined>
  readonly setActiveSelectionState: (value: SelectionEpochState) => void
  readonly setCurrentSelectionEpoch: (value: number) => void
  readonly setSelectedThreadId: (value: string) => void
}

export const makeInteractiveSelectionProjection = (input: InteractiveSelectionProjectionInput) => {
  const {
    activitySequence,
    interactiveThread,
    setActiveSelectionState,
    setCurrentSelectionEpoch,
    setSelectedThreadId,
  } = input
  const openSelectionProjectionFeed = (_state: SelectionEpochState) => Effect.void
  const startSelectionProjectionFeed = (_state: SelectionEpochState, _dispatch: (event: InteractiveEvent) => void) =>
    Effect.void
  const closeCandidateProjectionFeed = (_state: SelectionEpochState) => Effect.void
  const activateCreatedThread = Effect.fn("ProductOperation.interactive.activateCreatedThread")(function* (
    thread: Thread.Thread,
    epoch: number,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = yield* TurnRepository.Service
    const queue = yield* turns.readQueue(thread.id)
    const state = makeSelectionState(thread, epoch)
    setActiveSelectionState(state)
    setCurrentSelectionEpoch(epoch)
    setSelectedThreadId(String(thread.id))
    yield* Ref.set(interactiveThread, thread)
    dispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
    dispatch({
      _tag: "SelectionLoaded",
      selectionEpoch: epoch,
      activitySequence,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: queue.revision,
      queuedCount: queue.queuedCount,
      queue: queue.turns.map(queueItem),
    })
  })
  return {
    openSelectionProjectionFeed,
    startSelectionProjectionFeed,
    closeCandidateProjectionFeed,
    activateCreatedThread,
  }
}
