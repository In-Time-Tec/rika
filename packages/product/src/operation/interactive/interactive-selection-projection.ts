import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as LiveThreadProjection from "../../thread/projection/live-thread-projection"
import { Effect, Fiber, Ref, Scope, Stream } from "effect"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { makeSelectionState, type SelectionEpochState } from "./interactive-thread-selection"
import { queueItem } from "./interactive-session-queue"

export const hubFrameEvent: {
  (frame: LiveThreadProjection.HubFrame): (threadId: Thread.ThreadId) => InteractiveEvent
  (threadId: Thread.ThreadId, frame: LiveThreadProjection.HubFrame): InteractiveEvent
} = ((threadId: Thread.ThreadId, frame: LiveThreadProjection.HubFrame): InteractiveEvent => {
  switch (frame._tag) {
    case "Base":
      return { _tag: "ThreadViewHubBase", threadId, generation: frame.generation, base: frame.base, live: frame.live }
    case "Patch":
      return { _tag: "ThreadViewHubPatch", threadId, generation: frame.generation, patch: frame.patch }
    case "Live":
      return { _tag: "ThreadViewHubLive", threadId, generation: frame.generation, preview: frame.preview }
    case "LiveCleared":
      return {
        _tag: "ThreadViewHubLiveCleared",
        threadId,
        generation: frame.generation,
        turnId: frame.turnId,
        runId: frame.runId,
        attemptFence: frame.attemptFence,
        previewGeneration: frame.previewGeneration,
      }
    case "Generation":
      return { _tag: "ThreadViewHubGeneration", threadId, generation: frame.generation }
  }
}) as typeof hubFrameEvent

export interface InteractiveSelectionProjectionInput {
  readonly activitySequence: number
  readonly interactiveThread: Ref.Ref<Thread.Thread | undefined>
  readonly hub: LiveThreadProjection.Interface
  readonly sessionScope: Scope.Scope
  readonly setActiveSelectionState: (value: SelectionEpochState) => void
  readonly setCurrentSelectionEpoch: (value: number) => void
  readonly setSelectedThreadId: (value: string) => void
}

export const makeInteractiveSelectionProjection = (input: InteractiveSelectionProjectionInput) => {
  const {
    activitySequence,
    interactiveThread,
    hub,
    sessionScope,
    setActiveSelectionState,
    setCurrentSelectionEpoch,
    setSelectedThreadId,
  } = input
  let hubFiber: Fiber.Fiber<void, never> | undefined
  const openSelectionProjectionFeed = (_state: SelectionEpochState) => Effect.void
  const startSelectionProjectionFeed = Effect.fn("ProductOperation.interactive.startSelectionProjectionFeed")(
    function* (state: SelectionEpochState, dispatch: (event: InteractiveEvent) => void) {
      const previous = hubFiber
      hubFiber = undefined
      if (previous !== undefined) yield* Fiber.interrupt(previous).pipe(Effect.ignore)
      const fiber = yield* Effect.forkIn(
        Stream.runForEach(hub.watch(state.thread.id), (frame) =>
          Effect.sync(() => dispatch(hubFrameEvent(state.thread.id, frame))),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("interactive.hub.subscription.stopped").pipe(
              Effect.annotateLogs({
                "rika.thread.id": String(state.thread.id),
                "rika.failure.kind": String(cause),
              }),
            ),
          ),
        ),
        sessionScope,
      )
      hubFiber = fiber
    },
  )
  const closeCandidateProjectionFeed = (_state: SelectionEpochState) => Effect.void
  const activateCreatedThread = Effect.fn("ProductOperation.interactive.activateCreatedThread")(function* (
    thread: Thread.Thread,
    epoch: number,
    dispatch: (event: InteractiveEvent) => void,
    activeTurn?: Turn.Turn,
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
      ...(activeTurn === undefined ? {} : { activeTurn }),
    })
    yield* startSelectionProjectionFeed(state, dispatch)
  })
  return {
    openSelectionProjectionFeed,
    startSelectionProjectionFeed,
    closeCandidateProjectionFeed,
    activateCreatedThread,
  }
}
