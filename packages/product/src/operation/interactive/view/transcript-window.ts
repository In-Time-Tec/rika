import * as TranscriptPage from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { OperationError, operationError } from "../../error"
import { Effect, Clock, Fiber, Ref } from "effect"
import {
  boundTranscriptEntries,
  maximumTranscriptPayloadBytes,
  transcriptCursorFor,
  transcriptPageEncoder,
} from "../../../thread/transcript/bounds"
import { loadTranscriptWindow } from "../../../thread/transcript/window"
import * as InteractiveSelection from "./selection"
import type { InteractiveEvent } from "../session-event"
import type { InteractiveRuntimeContext } from "../session"
import { queueItem } from "../turn/queue"

type SelectionEpochState = InteractiveSelection.SelectionEpochState

export const boundedTranscriptPage = (input: {
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly hasOlder: boolean
  readonly encoder: <Value>(value: Value) => string
  readonly fail: (message: string) => Effect.Effect<never, OperationError, never>
}) => {
  const bounded = boundTranscriptEntries(input.entries, input.encoder)
  if (bounded.oversizedEntry) return input.fail("Transcript entry exceeds the transcript event limit")
  const entries = bounded.entries
  let hasOlder = input.hasOlder
  let oldestCursor: TranscriptPage.PageCursor | undefined
  if (bounded.truncated) {
    oldestCursor = bounded.partialCursor ?? transcriptCursorFor(entries[0])
    hasOlder = true
  }
  if (transcriptPageEncoder.encode(input.encoder(entries)).byteLength > maximumTranscriptPayloadBytes)
    return input.fail("Transcript page exceeds the transcript event limit")
  return Effect.succeed({ entries, hasOlder, oldestCursor })
}

export const initialTranscriptWindow = (input: {
  readonly state: SelectionEpochState
  readonly transcripts: Pick<TranscriptRepository.Interface, "page">
  readonly encodeJson: <Value>(value: Value) => string
  readonly fail: (message: string) => Effect.Effect<never, OperationError, never>
}) =>
  Effect.gen(function* () {
    const page = yield* loadTranscriptWindow(input.state.thread.id, input.transcripts)
    const bounded = yield* boundedTranscriptPage({
      entries: page.entries,
      hasOlder: page.hasOlder,
      encoder: input.encodeJson,
      fail: input.fail,
    })
    return {
      entries: bounded.entries,
      hasOlder: bounded.hasOlder,
      hasNewer: page.hasNewer,
      oldestCursor: bounded.oldestCursor ?? page.oldestCursor,
      newestCursor: transcriptCursorFor(bounded.entries.at(-1)),
      usage: page.usage,
    }
  })

export interface InteractiveTranscriptLifecycleInput extends InteractiveRuntimeContext {
  loadTranscriptPage: InteractiveTranscriptPageLoader
}

interface InteractiveTranscriptPageOwner {
  load?: InteractiveTranscriptPageLoader
}

export const makeInteractiveTranscriptLifecycle = (input: InteractiveTranscriptLifecycleInput) => {
  const {
    executionDependencies,
    sessionScope,
    getActiveSelectionState,
    selectionRequest,
    setCandidateSelectionState,
    openSelectionProjectionFeed,
    transcriptPageAdmission,
    notifyThreadSummaries,
    interactiveThread,
    closeCandidateProjectionFeed,
    interruptSelectionLoad,
    setSelectionLoadFiber,
    options,
    workspace,
    setSelectionLoad,
    activateCreatedThread,
    sessionDispatch,
    interruptSelectionBackground,
  } = input
  const loadThread = Effect.fn("ProductOperation.interactive.loadThread")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    if ((yield* Ref.get(selectionRequest)) !== request) return
    const state = InteractiveSelection.makeSelectionState(thread, request)
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
  const refreshThreadSummaries = notifyThreadSummaries.pipe(
    Effect.catch((error) =>
      Effect.logWarning("thread-summaries.refresh.failed").pipe(
        Effect.annotateLogs({ "rika.failure.kind": String(error) }),
      ),
    ),
  )
  const newThreadInput = Effect.fn("ProductOperation.interactive.newThreadInput")(function* () {
    return {
      id: yield* options.makeThreadId,
      workspace,
      title: "New thread",
      now: yield* Clock.currentTimeMillis,
    }
  })
  const createThread = Effect.fn("ProductOperation.interactive.createThread")(function* () {
    const threads = yield* ThreadRepository.Service
    return yield* threads.create(yield* newThreadInput())
  })
  const activateNewThread = Effect.fn("ProductOperation.interactive.activateNewThread")(function* (
    thread: Thread.Thread,
    preparedQueue?: TurnRepository.QueueSnapshot,
  ) {
    setCandidateSelectionState(undefined)
    yield* interruptSelectionLoad
    yield* interruptSelectionBackground
    const epoch = input.getCurrentSelectionEpoch() + 1
    setSelectionLoad(undefined)
    yield* Ref.set(selectionRequest, epoch)
    yield* activateCreatedThread(thread, epoch, sessionDispatch, undefined, preparedQueue)
    yield* refreshThreadSummaries
  })
  const createAndSelectThread = Effect.fn("ProductOperation.interactive.createAndSelectThread")(function* () {
    yield* activateNewThread(yield* createThread())
  })
  const archiveCurrentThread = Effect.fn("ProductOperation.interactive.archiveCurrentThread")(function* () {
    const current = yield* Ref.get(interactiveThread)
    if (current === undefined) return
    const threads = yield* ThreadRepository.Service
    yield* threads.setArchived(current.id, true, yield* Clock.currentTimeMillis)
    yield* refreshThreadSummaries
  })
  const archiveAndCreateThread = Effect.fn("ProductOperation.interactive.archiveAndCreateThread")(function* () {
    const current = yield* Ref.get(interactiveThread)
    if (current === undefined) return yield* createAndSelectThread()
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const createInput = yield* newThreadInput()
    const queue = yield* turns.readQueue(createInput.id)
    yield* Effect.uninterruptible(
      threads
        .archiveAndCreate(current.id, createInput)
        .pipe(Effect.flatMap((created) => activateNewThread(created, queue))),
    )
  })
  return {
    loadThread,
    runThreadLoad,
    createAndSelectThread,
    archiveCurrentThread,
    archiveAndCreateThread,
  }
}

export type InteractiveTranscriptPageLoader = (
  state: SelectionEpochState,
  dispatch: (event: InteractiveEvent) => void,
) => Effect.Effect<
  void,
  OperationError | TurnRepository.RepositoryError | TranscriptRepository.RepositoryError,
  TurnRepository.Service | TranscriptRepository.Service
>

export type InteractiveTranscriptPageInput = InteractiveRuntimeContext &
  ReturnType<typeof makeInteractiveTranscriptLifecycle> & {
    readonly initialTranscriptWindow: ReturnType<typeof makeInitialTranscriptWindow>
  }

export const makeInitialTranscriptWindow = (input: Pick<InteractiveRuntimeContext, "encodeJson">) =>
  Effect.fn("ProductOperation.interactive.initialTranscriptWindow")(function* (state: SelectionEpochState) {
    const transcripts = yield* TranscriptRepository.Service
    return yield* initialTranscriptWindow({
      state,
      transcripts,
      encodeJson: input.encodeJson,
      fail: operationError,
    })
  })

export const makeInteractiveTranscriptPage = (input: InteractiveTranscriptPageInput) => {
  const {
    isCurrentSelectionState,
    selectionRequest,
    getCandidateSelectionState,
    getSelectionLoad,
    interruptSelectionBackground,
    setActiveSelectionState,
    setCandidateSelectionState,
    setCurrentSelectionEpoch,
    interactiveThread,
    setSelectedThreadId,
    startSelectionProjectionFeed,
    operationFeed,
    setSelectionLoad,
    selectionAdmission,
    activitySequence,
    encodeJson,
    initialTranscriptWindow: loadInitialTranscriptWindow,
  } = input
  const loadTranscriptPage = Effect.fn("ProductOperation.interactive.loadTranscriptPage")(function* (
    state: SelectionEpochState,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const thread = state.thread
    const request = state.epoch
    const loadedAt = yield* Clock.currentTimeMillis
    const turns = yield* TurnRepository.Service
    const transcripts = yield* TranscriptRepository.Service
    if (isCurrentSelectionState(state) !== true) return
    const page = yield* loadInitialTranscriptWindow(state)
    let oldestCursor = page.oldestCursor
    let storedHasOlder = page.hasOlder
    let storedEntries = page.entries
    const bounded = boundTranscriptEntries(storedEntries, encodeJson)
    if (bounded.oversizedEntry === true)
      return yield* operationError("Transcript entry exceeds the transcript event limit")
    storedEntries = bounded.entries
    if (bounded.truncated === true) {
      const oldest = storedEntries[0]
      oldestCursor = bounded.partialCursor ?? transcriptCursorFor(oldest)
      storedHasOlder = true
    }
    const entries = storedEntries
    const hasOlder = storedHasOlder
    if (transcriptPageEncoder.encode(encodeJson(entries)).byteLength > maximumTranscriptPayloadBytes)
      return yield* operationError("Transcript page exceeds the transcript event limit")
    const completedAt = yield* Clock.currentTimeMillis
    if (isCurrentSelectionState(state) !== true) return
    state.transcriptCursor = oldestCursor
    state.newestTranscriptCursor = page.newestCursor ?? transcriptCursorFor(page.entries.at(-1))
    state.hasOlder = hasOlder
    if (isCurrentSelectionState(state) !== true || (yield* Ref.get(selectionRequest)) !== request) return
    yield* selectionAdmission.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if ((yield* Ref.get(selectionRequest)) !== request || getCandidateSelectionState() !== state) return
          const loading = getSelectionLoad()
          if (loading === undefined || loading.epoch !== request || loading.threadId !== String(thread.id)) return
          yield* interruptSelectionBackground
          setActiveSelectionState(state)
          setCandidateSelectionState(undefined)
          setCurrentSelectionEpoch(request)
          yield* Ref.set(interactiveThread, thread)
          setSelectedThreadId(String(thread.id))
          loading.committed = true
          const queue = yield* turns.readQueue(thread.id)
          const activeTurn = yield* turns.findActive(thread.id)
          const activeProjection = activeTurn === undefined ? undefined : yield* transcripts.get(activeTurn.id)
          let event: Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }> = {
            _tag: "SelectionLoaded",
            selectionEpoch: request,
            activitySequence,
            thread,
            entries,
            hasOlder,
            hasNewer: false,
            usage: page.usage,
            queueRevision: queue.revision,
            queuedCount: queue.queuedCount,
            queue: queue.turns.map(queueItem),
            projectionCheckpoints:
              activeProjection?.projectorCheckpoint === undefined
                ? []
                : [{ turnId: activeProjection.turn.id, checkpoint: activeProjection.projectorCheckpoint }],
          }
          if (oldestCursor !== undefined) event = { ...event, oldestCursor }
          if (page.newestCursor !== undefined) event = { ...event, newestCursor: page.newestCursor }
          if (activeTurn !== undefined) event = { ...event, activeTurn }
          dispatch(event)
          yield* startSelectionProjectionFeed(state, dispatch)
          operationFeed.releaseSelectionEvents(request, "Selection activity exceeded its bounded live window")
          setSelectionLoad(undefined)
        }),
      ),
    )
    yield* Effect.logInfo("transcript.page.loaded").pipe(
      Effect.annotateLogs({
        "rika.thread.id": String(thread.id),
        "rika.transcript.page.kind": "initial",
        "rika.transcript.page.units": entries.length,
        "rika.transcript.page.has_older": hasOlder,
        "rika.duration.ms": completedAt - loadedAt,
      }),
    )
  })
  return loadTranscriptPage
}

export const makeInteractiveTranscript = (input: InteractiveRuntimeContext) => {
  const pageLoader: InteractiveTranscriptPageOwner = {}
  const lifecycleInput: InteractiveTranscriptLifecycleInput = {
    ...input,
    loadTranscriptPage: (state, dispatch) => pageLoader.load!(state, dispatch),
  }
  const lifecycle = makeInteractiveTranscriptLifecycle(lifecycleInput)
  const loadInitialTranscriptWindow = makeInitialTranscriptWindow(input)
  const loadTranscriptPage = makeInteractiveTranscriptPage({
    ...input,
    ...lifecycle,
    initialTranscriptWindow: loadInitialTranscriptWindow,
  })
  pageLoader.load = loadTranscriptPage
  return { initialTranscriptWindow: loadInitialTranscriptWindow, loadTranscriptPage, ...lifecycle }
}
