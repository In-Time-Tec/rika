import * as TranscriptPage from "@rika/product/transcript-page"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { OperationError, operationError } from "../operation-error"
import { OperationUnavailable } from "../contract/product-operation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Context, Effect, Ref, Semaphore } from "effect"
import { isNewerSelectionEpoch, selectionMatches } from "./interactive-thread-selection"
import type { InteractiveSession } from "./interactive-session"

export const makeInteractiveSessionSelection = (
  input: any,
): Pick<
  InteractiveSession,
  "selectThread" | "readQueue" | "loadOlder" | "loadNewer" | "previewThread" | "reopenThread"
> => {
  const typedSelectionAdmission: Semaphore.Semaphore = input.selectionAdmission
  const typedSelectionRequest: Ref.Ref<number> = input.selectionRequest
  const typedInteractiveThread: Ref.Ref<Thread.Thread | undefined> = input.interactiveThread
  const typedTranscriptPageAdmission: Semaphore.Semaphore = input.transcriptPageAdmission
  const typedExecutionDependencies: Context.Context<
    | ThreadRepository.Service
    | TurnRepository.Service
    | TranscriptRepository.Service
    | ThreadSummaryRepository.Service
    | ExecutionBackend.Service
  > = input.executionDependencies
  const typedRunThreadLoad: (
    thread: Thread.Thread,
    epoch: number,
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationUnavailable, never> = input.runThreadLoad
  const typedEnsureIngest: (threadId: string, turnId: string) => Effect.Effect<void, OperationError, never> =
    input.ensureIngest
  const typedLoadTranscriptPage: (
    state: import("./interactive-thread-selection").SelectionEpochState,
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
    before?: TranscriptPage.PageCursor,
    loadedKeys?: ReadonlySet<string>,
  ) => Effect.Effect<void, OperationUnavailable, never> = input.loadTranscriptPage
  const safe: <A, E, R>(
    dispatch: (event: import("./interactive-event").InteractiveEvent) => void,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, OperationUnavailable, never> = input.safe
  const typedGetSelectionLoad: () =>
    | {
        readonly epoch: number
        readonly threadId: string
        readonly events: ReadonlyArray<import("./interactive-event").InteractiveEvent>
        readonly committed: boolean
        readonly overflow?: unknown
      }
    | undefined = input.getSelectionLoad
  const typedSetSelectionLoad: (value: {
    readonly epoch: number
    readonly threadId: string
    readonly previousEpoch: number
    readonly previousThreadId: string | undefined
    readonly events: ReadonlyArray<import("./interactive-event").InteractiveEvent>
    committed: boolean
  }) => void = input.setSelectionLoad
  const typedGetCurrentSelectionEpoch: () => number = input.getCurrentSelectionEpoch
  const typedFinishSelection: (epoch: number) => Effect.Effect<void, OperationError, never> = input.finishSelection
  const selectThread = (id: string, epoch: number) =>
    safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        const admitted = yield* typedSelectionAdmission.withPermits(1)(
          Effect.gen(function* () {
            if (!isNewerSelectionEpoch(epoch, (yield* Ref.get(typedSelectionRequest)) as number)) return false
            const previous = (yield* Ref.get(typedInteractiveThread)) as Thread.Thread | undefined
            const loaded = typedGetSelectionLoad()
            const joined = loaded?.epoch === 0 && loaded.threadId === id ? loaded : undefined
            typedSetSelectionLoad({
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
        yield* typedRunThreadLoad(thread, epoch, input.selectionDispatch(epoch))
      }).pipe(Effect.ensuring(typedFinishSelection(epoch).pipe(Effect.ignore))),
    )
  const readQueue = (id: string) =>
    safe(
      input.sessionDispatch,
      input.readQueue(Thread.ThreadId.make(id), input.selectionDispatch(typedGetCurrentSelectionEpoch())),
    )
  const loadOlder = (
    threadId: string,
    epoch: number,
    before: TranscriptPage.PageCursor | undefined,
    loadedKeys: ReadonlyArray<string>,
  ) =>
    safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        const state = input.getActiveSelectionState()
        if (!selectionMatches(state, threadId, epoch)) return
        yield* typedTranscriptPageAdmission.withPermits(1)(
          typedLoadTranscriptPage(state, input.selectionDispatch(state.epoch), before, new Set(loadedKeys)),
        )
      }),
    )
  const loadNewer = (threadId: string, epoch: number, after: TranscriptPage.PageCursor) =>
    safe(
      input.sessionDispatch,
      typedTranscriptPageAdmission.withPermits(1)(
        Effect.gen(function* () {
          const state = input.getActiveSelectionState()
          if (!selectionMatches(state, threadId, epoch)) return
          const page = yield* (yield* TranscriptRepository.Service).page(state.thread.id, { after, limit: 50 })
          if (input.isCurrentSelectionState(state) !== true) return
          state.newestTranscriptCursor = page.newestCursor ?? state.newestTranscriptCursor
          input.sessionDispatch({
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
      const backend = yield* ExecutionBackend.Service
      const thread = yield* threads.get(Thread.ThreadId.make(id))
      if (thread === undefined) return
      const recent = yield* turns.listRecentNonqueued(thread.id, 4)
      const previewTurns = yield* Effect.forEach(recent, (turn) =>
        Effect.gen(function* () {
          const projection = yield* transcripts.get(turn.id)
          const execution = yield* backend.inspect(turn.id).pipe(Effect.orElseSucceed(() => undefined))
          if (
            execution !== undefined &&
            (input.isTerminalStatus(execution.status) !== true ||
              projection === undefined ||
              projection.checkpointCursor !== execution.lastCursor)
          )
            yield* typedEnsureIngest(turn.threadId, turn.id)
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
      input.sessionDispatch({ _tag: "ThreadPreviewLoaded", threadId: id, turns: previewTurns })
    }).pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.orElseSucceed(() => undefined),
    )
  const reopenThread = (epoch: number) =>
    safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        if (!isNewerSelectionEpoch(epoch, (yield* Ref.get(typedSelectionRequest)) as number)) return
        const summary = (yield* (yield* ThreadSummaryRepository.Service).list({ limit: 1 }))[0]
        if (summary === undefined) return
        const thread = yield* (yield* ThreadRepository.Service).get(summary.id)
        if (thread === undefined) return yield* operationError(`Thread ${summary.id} does not exist`)
        yield* selectThread(String(thread.id), epoch)
      }).pipe(Effect.ensuring(typedFinishSelection(epoch).pipe(Effect.ignore))),
    )
  return { selectThread, readQueue, loadOlder, loadNewer, previewThread, reopenThread }
}
