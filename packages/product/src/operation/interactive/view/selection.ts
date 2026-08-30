import * as TranscriptPage from "@rika/product/transcript-page"
import * as Thread from "@rika/product/thread-record"

import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { Function, Effect, Ref, Cause, Semaphore } from "effect"
import type { InteractiveEvent } from "../session-event"
import { queueItem } from "../turn/queue"
import { OperationError, operationError } from "../../error"
import { promptUnit } from "./prompt-unit"
import type { InteractiveSession, InteractiveSessionSelectionInput } from "../session"

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
    activeTurn?: Turn.Turn,
    preparedQueue?: TurnRepository.QueueSnapshot,
  ) {
    const turns = yield* TurnRepository.Service
    const queue = preparedQueue ?? (yield* turns.readQueue(thread.id))
    const state = makeSelectionState(thread, epoch)
    setActiveSelectionState(state)
    setCurrentSelectionEpoch(epoch)
    setSelectedThreadId(String(thread.id))
    yield* Ref.set(interactiveThread, thread)
    dispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
    const loaded: Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }> = {
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
      projectionCheckpoints: [],
    }
    dispatch(activeTurn === undefined ? loaded : { ...loaded, activeTurn })
  })
  return {
    openSelectionProjectionFeed,
    startSelectionProjectionFeed,
    closeCandidateProjectionFeed,
    activateCreatedThread,
  }
}

export const makeInteractiveSessionSelection = (
  input: InteractiveSessionSelectionInput,
): Pick<InteractiveSession, "selectThread" | "readQueue" | "previewThread" | "reopenThread"> => {
  const {
    selectionAdmission,
    selectionRequest,
    interactiveThread,
    executionDependencies,
    runThreadLoad,
    safe,
    getSelectionLoad,
    setSelectionLoad,
    getCurrentSelectionEpoch,
    finishSelection,
    sessionDispatch,
    selectionDispatch,
    readQueue,
  } = input
  const typedSelectionAdmission: Semaphore.Semaphore = selectionAdmission
  const typedSelectionRequest: Ref.Ref<number> = selectionRequest
  const typedInteractiveThread: Ref.Ref<Thread.Thread | undefined> = interactiveThread
  const typedGetCurrentSelectionEpoch: () => number = getCurrentSelectionEpoch
  const typedFinishSelection: (epoch: number) => Effect.Effect<void, OperationError, never> = finishSelection
  const selectThread = (id: string) =>
    safe(
      sessionDispatch,
      Effect.gen(function* () {
        const epoch = yield* typedSelectionAdmission.withPermits(1)(
          Effect.gen(function* () {
            const next = (yield* Ref.get(typedSelectionRequest)) + 1
            const previous = yield* Ref.get(typedInteractiveThread)
            const loaded = getSelectionLoad()
            const joined = loaded?.epoch === 0 && loaded.threadId === id ? loaded : undefined
            const loading = {
              epoch: next,
              threadId: id,
              previousEpoch: typedGetCurrentSelectionEpoch(),
              previousThreadId: previous === undefined ? undefined : String(previous.id),
              events: joined?.events ?? [],
              committed: false,
            }
            setSelectionLoad(joined?.overflow === undefined ? loading : { ...loading, overflow: joined.overflow })
            yield* Ref.set(typedSelectionRequest, next)
            return next
          }),
        )
        const thread = yield* (yield* ThreadRepository.Service).get(Thread.ThreadId.make(id))
        if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
        yield* runThreadLoad(thread, epoch, selectionDispatch(epoch)).pipe(
          Effect.ensuring(typedFinishSelection(epoch).pipe(Effect.ignore)),
        )
      }),
    )
  const readQueueOperation = (id: string) =>
    safe(sessionDispatch, readQueue(Thread.ThreadId.make(id), selectionDispatch(typedGetCurrentSelectionEpoch())))
  const previewThread = (id: string, requestId: number) =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const thread = yield* threads.get(Thread.ThreadId.make(id))
      if (thread === undefined) {
        sessionDispatch({ _tag: "ThreadPreviewFailed", threadId: id, requestId, message: "Thread not found" })
        return
      }
      const recent = yield* turns.listRecentNonqueued(thread.id, 4)
      const previewUnits = yield* Effect.forEach(recent, (turn) =>
        Effect.gen(function* () {
          const projection = yield* transcripts.get(turn.id)
          return projection?.units ?? [promptUnit(turn)]
        }).pipe(Effect.orElseSucceed(() => [promptUnit(turn)])),
      )
      sessionDispatch({ _tag: "ThreadPreviewLoaded", threadId: id, requestId, units: previewUnits.flat() })
    }).pipe(
      Effect.provide(executionDependencies),
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          sessionDispatch({ _tag: "ThreadPreviewFailed", threadId: id, requestId, message: Cause.pretty(cause) }),
        ),
      ),
    )
  const reopenThread = safe(
    sessionDispatch,
    Effect.gen(function* () {
      const summary = (yield* (yield* ThreadSummaryRepository.Service).list({ limit: 1 }))[0]
      if (summary === undefined) return
      const thread = yield* (yield* ThreadRepository.Service).get(summary.id)
      if (thread === undefined) return yield* operationError(`Thread ${summary.id} does not exist`)
      yield* selectThread(String(thread.id))
    }),
  )
  return { selectThread, readQueue: readQueueOperation, previewThread, reopenThread }
}
