import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { OperationError } from "../operation-error"
import type { ProjectionChange } from "../../execution/ingest/execution-ingest-event"
import { Function, Effect, Exit, Ref, Scope, Stream } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import { makeSelectionState, type SelectionEpochState } from "./interactive-thread-selection"
import { queueItem } from "./interactive-session-queue"

export type ThreadUsageEvent = Extract<InteractiveEvent, { readonly _tag: "ThreadUsageUpdated" }>

const initializeSelectedUsageImpl = (threadId: Thread.ThreadId, request: number): ThreadUsageEvent => ({
  _tag: "ThreadUsageUpdated",
  selectionEpoch: request,
  threadId,
  revision: 0,
  context: { _tag: "Unavailable" },
  cost: { _tag: "Unavailable" },
  tokens: { _tag: "Unavailable" },
  time: { _tag: "Unavailable" },
})

export const initializeSelectedUsage: {
  (arg1: number): (arg0: Thread.ThreadId) => ReturnType<typeof initializeSelectedUsageImpl>
  (arg0: Thread.ThreadId, arg1: number): ReturnType<typeof initializeSelectedUsageImpl>
} = Function.dual(2, initializeSelectedUsageImpl)

export const transcriptProjectionEvent = (change: ProjectionChange): InteractiveEvent => {
  switch (change._tag) {
    case "ProjectionStarted": {
      const { rootStatus: startedRootStatus, ...snapshot } = change.snapshot
      return {
        _tag: "TranscriptProjectionStarted",
        selectionEpoch: 0,
        ...snapshot,
        ...(startedRootStatus === undefined ? {} : { rootStatus: startedRootStatus }),
      }
    }
    case "ProjectionPatched": {
      const { rootStatus: patchedRootStatus, ...patch } = change.patch
      return {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: 0,
        ...patch,
        ...(patchedRootStatus === undefined ? {} : { rootStatus: patchedRootStatus }),
      }
    }
    case "ProjectionStopped":
      return {
        _tag: "TranscriptProjectionStopped",
        selectionEpoch: 0,
        threadId: change.threadId,
        rootTurnId: change.rootTurnId,
        streamId: change.streamId,
        patchRevision: change.patchRevision,
        status: change.status,
      }
    case "ProjectionFailed":
      return {
        _tag: "TranscriptProjectionFailed",
        selectionEpoch: 0,
        threadId: change.threadId,
        rootTurnId: change.rootTurnId,
        streamId: change.streamId,
        patchRevision: change.patchRevision,
        executionId: change.failure.executionId ?? String(change.rootTurnId),
        reason: change.failure.reason,
        message: change.failure.message,
      }
    default:
      return Function.absurd(change)
  }
}

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
  const openSelectionProjectionFeed = (state: SelectionEpochState): Effect.Effect<void, OperationError, never> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const watch = yield* typedExecutionIngest
        .watchThread(state.thread.id)
        .pipe(Effect.provideService(Scope.Scope, scope))
      state.projectionFeed = { watch, scope, promoted: false }
    }).pipe(Effect.mapError((error) => OperationError.make({ message: String(error), cause: error })))
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
  const typedExecutionIngest: ExecutionIngest.Interface = executionIngest
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
