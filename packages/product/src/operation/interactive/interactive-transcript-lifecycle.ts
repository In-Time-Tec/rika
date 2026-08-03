import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as UsageRepository from "@rika/product/usage-repository"
import { OperationError } from "../operation-error"
import { Context, Clock, Effect, Fiber, Ref, Scope, Semaphore } from "effect"
import { makeSelectionState, type SelectionEpochState } from "./interactive-thread-selection"
import type { ThreadContext } from "./interactive-thread-context"

export const makeInteractiveTranscriptLifecycle = (input: any) => {
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
  const typedUsageRepository: UsageRepository.Interface = usageRepository
  const typedExecutionDependencies: Context.Context<
    UsageRepository.Service | ThreadRepository.Service | ThreadSummaryRepository.Service
  > = executionDependencies
  const typedSessionScope: Scope.Scope = sessionScope
  const typedGetActiveSelectionState: () => SelectionEpochState | undefined = getActiveSelectionState
  const typedSelectionRequest: Ref.Ref<number> = selectionRequest
  const typedTranscriptPageAdmission: Semaphore.Semaphore = transcriptPageAdmission
  const typedNotifyThreadSummaries: Effect.Effect<void, OperationError, never> = notifyThreadSummaries
  const typedReadThreadContext: (threadId: string) => Effect.Effect<ThreadContext, Error> = input.readThreadContext
  const typedLoadTranscriptPage = (
    state: SelectionEpochState,
    dispatch: (event: any) => void,
  ): Effect.Effect<void, OperationError, never> => input.loadTranscriptPage(state, dispatch)
  const typedOpenSelectionProjectionFeed: (state: SelectionEpochState) => Effect.Effect<void, OperationError, never> =
    openSelectionProjectionFeed
  const typedCloseCandidateProjectionFeed: (state: SelectionEpochState) => Effect.Effect<void, OperationError, never> =
    closeCandidateProjectionFeed
  const typedInterruptSelectionLoad: Effect.Effect<void, OperationError, never> = interruptSelectionLoad
  const typedSetSelectionLoadFiber: (fiber: Fiber.Fiber<unknown, unknown>) => void = setSelectionLoadFiber
  const startSelectionUsage = (state: SelectionEpochState, dispatch: (event: any) => void) =>
    Effect.gen(function* () {
      selectionBackground.push(
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const totals = yield* typedUsageRepository.readThread(String(state.thread.id))
            if (typedGetActiveSelectionState() !== state) return
            dispatch({
              _tag: "ThreadUsageUpdated",
              selectionEpoch: state.epoch,
              threadId: state.thread.id,
              revision: totals.revision,
              ...input.persistedThreadUsage(totals, { _tag: "Unavailable" }),
            })
            const context = yield* typedReadThreadContext(String(state.thread.id)).pipe(
              Effect.orElseSucceed(() => ({ _tag: "Unavailable" }) as const),
            )
            if (typedGetActiveSelectionState() !== state || context._tag === "Unavailable") return
            dispatch({
              _tag: "ThreadUsageUpdated",
              selectionEpoch: state.epoch,
              threadId: state.thread.id,
              revision: totals.revision,
              ...input.persistedThreadUsage(totals, context),
            })
          }).pipe(Effect.provide(typedExecutionDependencies)),
          typedSessionScope,
        ),
      )
    })
  const loadThread = Effect.fn("ProductOperation.interactive.loadThread")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: any) => void,
  ) {
    if ((yield* Ref.get(typedSelectionRequest)) !== request) return
    const state = makeSelectionState(thread, request)
    setCandidateSelectionState(state)
    yield* typedOpenSelectionProjectionFeed(state)
    yield* Effect.gen(function* () {
      yield* typedTranscriptPageAdmission.withPermits(1)(typedLoadTranscriptPage(state, dispatch))
      if (typedGetActiveSelectionState() !== state) return
      const summaries = yield* ThreadSummaryRepository.Service
      yield* summaries.markRead(thread.id, yield* Clock.currentTimeMillis)
      yield* typedNotifyThreadSummaries
    }).pipe(Effect.ensuring(typedCloseCandidateProjectionFeed(state).pipe(Effect.ignore)))
  })
  const runThreadLoad = Effect.fn("ProductOperation.interactive.runThreadLoad")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: any) => void,
  ) {
    yield* typedInterruptSelectionLoad
    if ((yield* Ref.get(typedSelectionRequest)) !== request) return
    const fiber = yield* Effect.forkIn(
      loadThread(thread, request, dispatch).pipe(Effect.provide(typedExecutionDependencies)),
      typedSessionScope,
    )
    typedSetSelectionLoadFiber(fiber)
    yield* Fiber.join(fiber).pipe(
      Effect.catchCause((cause) =>
        Ref.get(typedSelectionRequest).pipe(
          Effect.flatMap((current) => (current === request ? Effect.failCause(cause) : Effect.void)),
        ),
      ),
    )
  })
  const createAndSelectThread = Effect.fn("ProductOperation.interactive.createAndSelectThread")(function* () {
    setActiveSelectionState(undefined)
    setCandidateSelectionState(undefined)
    yield* typedInterruptSelectionLoad
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
    yield* typedNotifyThreadSummaries
  })
  return { startSelectionUsage, loadThread, runThreadLoad, createAndSelectThread }
}
