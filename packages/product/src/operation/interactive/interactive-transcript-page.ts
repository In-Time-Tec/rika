import * as TranscriptPage from "@rika/product/transcript-page"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import {
  boundTranscriptEntries,
  maximumTranscriptPayloadBytes,
  sameTranscriptCursor,
  transcriptCursorFor,
  transcriptPageEncoder,
} from "../../transcript/transcript-bounds"
import { initialTranscriptWindow as buildInitialTranscriptWindow } from "./transcript-window"
import {
  isNewerSelectionEpoch as _isNewerSelectionEpoch,
  selectionMatches as _selectionMatches,
} from "./interactive-thread-selection"
import { Effect, Clock, Ref } from "effect"
import { queueItem } from "./interactive-session-queue"
import type { SelectionEpochState } from "./interactive-thread-selection"
import { OperationError, operationError } from "../operation-error"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"
import type { makeInteractiveTranscriptLifecycle } from "./interactive-transcript-lifecycle"

export type InteractiveTranscriptPageLoader = (
  state: SelectionEpochState,
  dispatch: (event: InteractiveEvent) => void,
  before?: TranscriptPage.PageCursor,
) => Effect.Effect<
  void,
  OperationError | TurnRepository.RepositoryError | TranscriptRepository.RepositoryError,
  TurnRepository.Service | TranscriptRepository.Service
>

export type InteractiveTranscriptPageInput = InteractiveRuntimeContext &
  ReturnType<typeof makeInteractiveTranscriptLifecycle> & {
    readonly initialTranscriptWindow: ReturnType<typeof makeInitialTranscriptWindow>
  }

export const makeInitialTranscriptWindow = (
  input: Pick<InteractiveRuntimeContext, "selectionInitialTurnWindow" | "selectionInitialEntryWindow">,
) =>
  Effect.fn("ProductOperation.interactive.initialTranscriptWindow")(function* (state: SelectionEpochState) {
    const { selectionInitialTurnWindow, selectionInitialEntryWindow } = input
    const turns = yield* TurnRepository.Service
    const transcripts = yield* TranscriptRepository.Service
    return yield* buildInitialTranscriptWindow({
      state,
      turns,
      transcripts,
      maxTurns: selectionInitialTurnWindow,
      maxEntries: selectionInitialEntryWindow,
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
    initialTranscriptWindow,
  } = input
  const loadTranscriptPage = Effect.fn("ProductOperation.interactive.loadTranscriptPage")(function* (
    state: SelectionEpochState,
    dispatch: (event: InteractiveEvent) => void,
    before?: TranscriptPage.PageCursor,
  ) {
    const thread = state.thread
    const request = state.epoch
    const loadedAt = yield* Clock.currentTimeMillis
    const turns = yield* TurnRepository.Service
    const transcripts = yield* TranscriptRepository.Service
    if (isCurrentSelectionState(state) !== true) return
    const page =
      before === undefined
        ? yield* initialTranscriptWindow(state)
        : yield* transcripts.page(thread.id, {
            before,
            limit: 50,
            projectionVersion: ExecutionProjection.projectionVersion,
          })
    if (
      page.hasOlder === true &&
      before !== undefined &&
      (page.entries.length === 0 ||
        page.oldestCursor === undefined ||
        sameTranscriptCursor(page.oldestCursor, before, encodeJson))
    )
      return yield* operationError(`Transcript page did not advance for Thread ${thread.id}`)
    let oldestCursor = page.oldestCursor
    let storedHasOlder = page.hasOlder
    let initialBoundary = -1
    let storedEntries = page.entries
    const bounded = boundTranscriptEntries(storedEntries, encodeJson)
    if (bounded.oversizedEntry === true)
      return yield* operationError("Transcript entry exceeds the transcript event limit")
    storedEntries = bounded.entries
    if (bounded.truncated === true) {
      initialBoundary = 1
    }
    if (initialBoundary > 0) {
      const oldest = storedEntries[0]
      if (bounded.partialCursor !== undefined) oldestCursor = bounded.partialCursor
      else oldestCursor = transcriptCursorFor(oldest)
      storedHasOlder = true
    }
    const entries = storedEntries
    const hasOlder = storedHasOlder
    if (transcriptPageEncoder.encode(encodeJson(entries)).byteLength > maximumTranscriptPayloadBytes)
      return yield* operationError("Transcript page exceeds the transcript event limit")
    const deliveredEntries = entries
    const completedAt = yield* Clock.currentTimeMillis
    if (isCurrentSelectionState(state) !== true) return
    state.transcriptCursor = oldestCursor
    if (before === undefined)
      state.newestTranscriptCursor =
        "newestCursor" in page ? page.newestCursor : transcriptCursorFor(page.entries.at(-1))
    state.hasOlder = hasOlder
    if (before === undefined) {
      const queue = yield* turns.readQueue(thread.id)
      const activeTurn = yield* turns.findActive(thread.id)
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
            dispatch({
              _tag: "SelectionLoaded",
              selectionEpoch: request,
              activitySequence,
              thread,
              entries,
              hasOlder,
              hasNewer: false,
              usage: page.usage,
              ...(oldestCursor === undefined ? {} : { oldestCursor }),
              ...("newestCursor" in page && page.newestCursor !== undefined ? { newestCursor: page.newestCursor } : {}),
              queueRevision: queue.revision,
              queuedCount: queue.queuedCount,
              queue: queue.turns.map(queueItem),
              ...(activeTurn === undefined ? {} : { activeTurn }),
            })
            yield* startSelectionProjectionFeed(state, dispatch)
            operationFeed.releaseSelectionEvents(request, "Selection activity exceeded its bounded live window")
            setSelectionLoad(undefined)
          }),
        ),
      )
    } else {
      if (isCurrentSelectionState(state) !== true) return
      dispatch({
        _tag: "TranscriptPagePrepended",
        selectionEpoch: request,
        threadId: thread.id,
        entries: deliveredEntries,
        hasOlder,
        ...(oldestCursor === undefined ? {} : { oldestCursor }),
      })
    }
    yield* Effect.logInfo("transcript.page.loaded").pipe(
      Effect.annotateLogs({
        "rika.thread.id": String(thread.id),
        "rika.transcript.page.kind": before === undefined ? "initial" : "prepend",
        "rika.transcript.page.units": deliveredEntries.length,
        "rika.transcript.page.has_older": hasOlder,
        "rika.duration.ms": completedAt - loadedAt,
      }),
    )
  })
  return loadTranscriptPage
}
