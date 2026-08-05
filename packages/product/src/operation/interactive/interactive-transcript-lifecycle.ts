import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { Clock, Effect, Fiber, Ref } from "effect"
import { makeSelectionState, type SelectionEpochState } from "./interactive-thread-selection"
import type { InteractiveEvent } from "./interactive-event"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"
import type { persistedThreadUsage } from "./interactive-session-transcript-runtime"
import type { InteractiveTranscriptPageLoader } from "./interactive-transcript-page"

export interface InteractiveTranscriptLifecycleInput extends InteractiveRuntimeContext {
  readonly persistedThreadUsage: typeof persistedThreadUsage
  loadTranscriptPage: InteractiveTranscriptPageLoader
}

export const makeInteractiveTranscriptLifecycle = (input: InteractiveTranscriptLifecycleInput) => {
  const {
    selectionBackground,
    usageRepository,
    executionDependencies,
    sessionScope,
    getActiveSelectionState,
    selectionRequest,
    setCandidateSelectionState,
    openSelectionProjectionFeed,
    transcriptPageAdmission,
    notifyThreadSummaries,
    closeCandidateProjectionFeed,
    interruptSelectionLoad,
    setSelectionLoadFiber,
    setActiveSelectionState,
    options,
    workspace,
    setSelectionLoad,
    activateCreatedThread,
    sessionDispatch,
    interruptSelectionBackground,
  } = input
  const startSelectionUsage = (state: SelectionEpochState, dispatch: (event: InteractiveEvent) => void) =>
    Effect.gen(function* () {
      selectionBackground.push(
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const totals = yield* usageRepository.readThread(String(state.thread.id))
            if (getActiveSelectionState() !== state) return
            dispatch({
              _tag: "ThreadUsageUpdated",
              selectionEpoch: state.epoch,
              threadId: state.thread.id,
              revision: totals.revision,
              ...input.persistedThreadUsage(totals, { _tag: "Unavailable" }),
            })
            const context = yield* input
              .readThreadContext(String(state.thread.id))
              .pipe(Effect.orElseSucceed(() => ({ _tag: "Unavailable" }) as const))
            if (getActiveSelectionState() !== state || context._tag === "Unavailable") return
            dispatch({
              _tag: "ThreadUsageUpdated",
              selectionEpoch: state.epoch,
              threadId: state.thread.id,
              revision: totals.revision,
              ...input.persistedThreadUsage(totals, context),
            })
          }).pipe(Effect.provide(executionDependencies)),
          sessionScope,
        ),
      )
    })
  const loadThread = Effect.fn("ProductOperation.interactive.loadThread")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    if ((yield* Ref.get(selectionRequest)) !== request) return
    const state = makeSelectionState(thread, request)
    setCandidateSelectionState(state)
    yield* openSelectionProjectionFeed(state)
    yield* Effect.gen(function* () {
      yield* transcriptPageAdmission.withPermits(1)(input.loadTranscriptPage(state, dispatch))
      if (getActiveSelectionState() !== state) return
      const summaries = yield* ThreadSummaryRepository.Service
      yield* summaries.markRead(thread.id, yield* Clock.currentTimeMillis)
      yield* notifyThreadSummaries
    }).pipe(Effect.ensuring(closeCandidateProjectionFeed(state).pipe(Effect.ignore)))
  })
  const runThreadLoad = Effect.fn("ProductOperation.interactive.runThreadLoad")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    yield* interruptSelectionLoad
    if ((yield* Ref.get(selectionRequest)) !== request) return
    const fiber = yield* Effect.forkIn(
      loadThread(thread, request, dispatch).pipe(Effect.provide(executionDependencies)),
      sessionScope,
    )
    setSelectionLoadFiber(fiber)
    yield* Fiber.join(fiber).pipe(
      Effect.catchCause((cause) =>
        Ref.get(selectionRequest).pipe(
          Effect.flatMap((current) => (current === request ? Effect.failCause(cause) : Effect.void)),
        ),
      ),
    )
  })
  const createAndSelectThread = Effect.fn("ProductOperation.interactive.createAndSelectThread")(function* () {
    setActiveSelectionState(undefined)
    setCandidateSelectionState(undefined)
    yield* interruptSelectionLoad
    yield* interruptSelectionBackground
    const threads = yield* ThreadRepository.Service
    const thread = yield* threads.create({
      id: yield* options.makeThreadId,
      workspace,
      title: "New thread",
      now: yield* Clock.currentTimeMillis,
    })
    const epoch = input.getCurrentSelectionEpoch() + 1
    setSelectionLoad(undefined)
    yield* Ref.set(selectionRequest, epoch)
    yield* activateCreatedThread(thread, epoch, sessionDispatch)
    yield* notifyThreadSummaries
  })
  return { startSelectionUsage, loadThread, runThreadLoad, createAndSelectThread }
}
