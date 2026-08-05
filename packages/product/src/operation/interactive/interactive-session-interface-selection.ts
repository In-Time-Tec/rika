import * as TranscriptPage from "@rika/product/transcript-page"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { OperationError, operationError } from "../operation-error"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Cause, Effect, Ref, Semaphore } from "effect"
import { isNewerSelectionEpoch, selectionMatches } from "./interactive-thread-selection"
import type { InteractiveSession } from "./interactive-session"
import type { InteractiveSessionSelectionInput } from "./interactive-session-interface"

export const makeInteractiveSessionSelection = (
  input: InteractiveSessionSelectionInput,
): Pick<
  InteractiveSession,
  "selectThread" | "readQueue" | "loadOlder" | "loadNewer" | "previewThread" | "reopenThread"
> => {
  const {
    selectionAdmission,
    selectionRequest,
    interactiveThread,
    transcriptPageAdmission,
    executionDependencies,
    runThreadLoad,
    ensureIngest,
    loadTranscriptPage,
    safe,
    getSelectionLoad,
    setSelectionLoad,
    getCurrentSelectionEpoch,
    finishSelection,
    sessionDispatch,
    selectionDispatch,
    readQueue,
    getActiveSelectionState,
    isCurrentSelectionState,
    isTerminalStatus,
  } = input
  const typedSelectionAdmission: Semaphore.Semaphore = selectionAdmission
  const typedSelectionRequest: Ref.Ref<number> = selectionRequest
  const typedInteractiveThread: Ref.Ref<Thread.Thread | undefined> = interactiveThread
  const typedTranscriptPageAdmission: Semaphore.Semaphore = transcriptPageAdmission
  const typedGetCurrentSelectionEpoch: () => number = getCurrentSelectionEpoch
  const typedFinishSelection: (epoch: number) => Effect.Effect<void, OperationError, never> = finishSelection
  const selectThread = (id: string, epoch: number) =>
    safe(
      sessionDispatch,
      Effect.gen(function* () {
        const admitted = yield* typedSelectionAdmission.withPermits(1)(
          Effect.gen(function* () {
            if (!isNewerSelectionEpoch(epoch, yield* Ref.get(typedSelectionRequest))) return false
            const previous = yield* Ref.get(typedInteractiveThread)
            const loaded = getSelectionLoad()
            const joined = loaded?.epoch === 0 && loaded.threadId === id ? loaded : undefined
            setSelectionLoad({
              epoch,
              threadId: id,
              previousEpoch: typedGetCurrentSelectionEpoch(),
              previousThreadId: previous === undefined ? undefined : String(previous.id),
              events: joined?.events ?? [],
              committed: false,
              ...(joined?.overflow === undefined ? {} : { overflow: joined.overflow }),
            })
            yield* Ref.set(typedSelectionRequest, epoch)
            return true
          }),
        )
        if (admitted !== true) return
        const thread = yield* (yield* ThreadRepository.Service).get(Thread.ThreadId.make(id))
        if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
        yield* runThreadLoad(thread, epoch, selectionDispatch(epoch))
      }).pipe(Effect.ensuring(typedFinishSelection(epoch).pipe(Effect.ignore))),
    )
  const readQueueOperation = (id: string) =>
    safe(sessionDispatch, readQueue(Thread.ThreadId.make(id), selectionDispatch(typedGetCurrentSelectionEpoch())))
  const loadOlder = (
    threadId: string,
    epoch: number,
    before: TranscriptPage.PageCursor | undefined,
    loadedKeys: ReadonlyArray<string>,
  ) =>
    safe(
      sessionDispatch,
      Effect.gen(function* () {
        const state = getActiveSelectionState()
        if (state === undefined || !selectionMatches(state, threadId, epoch)) return
        yield* typedTranscriptPageAdmission.withPermits(1)(
          loadTranscriptPage(state, selectionDispatch(state.epoch), before, new Set(loadedKeys)),
        )
      }),
    )
  const loadNewer = (threadId: string, epoch: number, after: TranscriptPage.PageCursor) =>
    safe(
      sessionDispatch,
      typedTranscriptPageAdmission.withPermits(1)(
        Effect.gen(function* () {
          const state = getActiveSelectionState()
          if (state === undefined || !selectionMatches(state, threadId, epoch)) return
          const page = yield* (yield* TranscriptRepository.Service).page(state.thread.id, { after, limit: 50 })
          if (isCurrentSelectionState(state) !== true) return
          state.newestTranscriptCursor = page.newestCursor ?? state.newestTranscriptCursor
          sessionDispatch({
            _tag: "TranscriptPageAppended",
            selectionEpoch: state.epoch,
            threadId: state.thread.id,
            entries: page.entries,
            hasNewer: page.hasNewer ?? false,
            requestedAfter: after,
            ...(page.threadCostUsd === undefined ? {} : { threadCostUsd: page.threadCostUsd }),
            ...(page.newestCursor === undefined ? {} : { newestCursor: page.newestCursor }),
          })
        }),
      ),
    )
  const previewThread = (id: string) =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const backend = yield* ExecutionGateway.Service
      const thread = yield* threads.get(Thread.ThreadId.make(id))
      if (thread === undefined) {
        sessionDispatch({ _tag: "ThreadPreviewFailed", threadId: id, message: "Thread not found" })
        return
      }
      const recent = yield* turns.listRecentNonqueued(thread.id, 4)
      const previewTurns = yield* Effect.forEach(recent, (turn) =>
        Effect.gen(function* () {
          const projection = yield* transcripts.get(turn.id)
          const execution =
            turn._tag !== "AgentExecution" || turn.executionLink === undefined
              ? undefined
              : yield* backend.inspectTurn(turn.executionLink).pipe(Effect.orElseSucceed(() => undefined))
          if (
            execution !== undefined &&
            execution.status !== "unavailable" &&
            (isTerminalStatus(execution.status) !== true ||
              projection === undefined ||
              projection.checkpointCursor !== execution.cursor)
          )
            yield* ensureIngest(turn.threadId, turn.id)
          return {
            prompt: turn.prompt,
            units: projection?.units ?? TranscriptProjection.Projection.empty(turn.id, turn.prompt).units,
          }
        }).pipe(
          Effect.orElseSucceed(() => ({
            prompt: turn.prompt,
            units: TranscriptProjection.Projection.empty(turn.id, turn.prompt).units,
          })),
        ),
      )
      sessionDispatch({ _tag: "ThreadPreviewLoaded", threadId: id, turns: previewTurns })
    }).pipe(
      Effect.provide(executionDependencies),
      Effect.catchCause((cause) =>
        Effect.sync(() => sessionDispatch({ _tag: "ThreadPreviewFailed", threadId: id, message: Cause.pretty(cause) })),
      ),
    )
  const reopenThread = (epoch: number) =>
    safe(
      sessionDispatch,
      Effect.gen(function* () {
        if (!isNewerSelectionEpoch(epoch, yield* Ref.get(typedSelectionRequest))) return
        const summary = (yield* (yield* ThreadSummaryRepository.Service).list({ limit: 1 }))[0]
        if (summary === undefined) return
        const thread = yield* (yield* ThreadRepository.Service).get(summary.id)
        if (thread === undefined) return yield* operationError(`Thread ${summary.id} does not exist`)
        yield* selectThread(String(thread.id), epoch)
      }).pipe(Effect.ensuring(typedFinishSelection(epoch).pipe(Effect.ignore))),
    )
  return { selectThread, readQueue: readQueueOperation, loadOlder, loadNewer, previewThread, reopenThread }
}
