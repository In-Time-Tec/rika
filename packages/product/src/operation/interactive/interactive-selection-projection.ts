import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Effect, Exit, Ref, Scope, Stream } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import {
  initializeSelectedUsage,
  makeSelectionState,
  queueItem,
  transcriptProjectionEvent,
} from "../dispatch/execution-operation-coordination"
import type { SelectionEpochState } from "../dispatch/execution-operation-coordination"

export const makeInteractiveSelectionProjection = (input: any) => {
  const {
    executionIngest,
    sessionScope,
    selectionBackground,
    operationFeed: _operationFeed,
    activitySequence,
    interactiveThread,
    setActiveSelectionState,
    setCurrentSelectionEpoch,
    setSelectedThreadId,
  } = input
  const openSelectionProjectionFeed = Effect.fn("ProductOperation.interactive.openSelectionProjectionFeed")(function* (
    state: SelectionEpochState,
  ) {
    const scope = yield* Scope.make()
    const watch = yield* executionIngest.watchThread(state.thread.id).pipe(Effect.provideService(Scope.Scope, scope))
    state.projectionFeed = { watch, scope, promoted: false }
  })
  const startSelectionProjectionFeed = Effect.fn("ProductOperation.interactive.startSelectionProjectionFeed")(
    function* (state: SelectionEpochState, dispatch: (event: InteractiveEvent) => void) {
      const feed = state.projectionFeed
      if (feed === undefined || feed.promoted) return
      feed.promoted = true
      dispatch({
        _tag: "ThreadRefolding",
        selectionEpoch: state.epoch,
        threadId: state.thread.id,
        refolding: feed.watch.refolding,
      })
      for (const snapshot of feed.watch.snapshots)
        dispatch(transcriptProjectionEvent({ _tag: "ProjectionStarted", snapshot }))
      selectionBackground.push(
        yield* Effect.forkIn(
          feed.watch.changes.pipe(
            Stream.runForEach((change) => Effect.sync(() => dispatch(transcriptProjectionEvent(change)))),
            Effect.catchTag("ExecutionIngestProjectionWatchOverflow", (error) =>
              Effect.sync(() =>
                dispatch({
                  _tag: "TranscriptResyncRequired",
                  selectionEpoch: state.epoch,
                  threadId: state.thread.id,
                  reason: `Projection feed exceeded its bounded capacity of ${error.capacity}`,
                }),
              ),
            ),
            Effect.ensuring(Scope.close(feed.scope, Exit.void)),
          ),
          sessionScope,
        ),
      )
    },
  )
  const closeCandidateProjectionFeed = (state: SelectionEpochState) =>
    Effect.suspend(() => {
      const feed = state.projectionFeed
      return feed === undefined || feed.promoted ? Effect.void : Scope.close(feed.scope, Exit.void)
    })
  const activateCreatedThread = Effect.fn("ProductOperation.interactive.activateCreatedThread")(function* (
    thread: Thread.Thread,
    epoch: number,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = yield* TurnRepository.Service
    const queue = yield* turns.readQueue(thread.id)
    const state = makeSelectionState(thread, epoch)
    yield* openSelectionProjectionFeed(state)
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
      queueRevision: queue.revision,
      queuedCount: queue.queuedCount,
      queue: queue.turns.map(queueItem),
    })
    yield* startSelectionProjectionFeed(state, dispatch)
    dispatch(initializeSelectedUsage(thread.id, epoch))
  })
  return {
    openSelectionProjectionFeed,
    startSelectionProjectionFeed,
    closeCandidateProjectionFeed,
    activateCreatedThread,
  }
}
