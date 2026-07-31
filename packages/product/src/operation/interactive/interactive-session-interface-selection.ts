import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { operationError } from "../operation-error"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, Ref } from "effect"
import { isNewerSelectionEpoch, selectionMatches } from "./interactive-thread-selection"
import type { InteractiveSession } from "./interactive-session"

export const makeInteractiveSessionSelection = (
  input: any,
): Pick<
  InteractiveSession,
  "selectThread" | "readQueue" | "loadOlder" | "loadNewer" | "previewThread" | "reopenThread"
> => {
  const selectThread = (id: string, epoch: number) =>
    input.safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        const admitted = yield* input.selectionAdmission.withPermits(1)(
          Effect.gen(function* () {
            if (!isNewerSelectionEpoch(epoch, (yield* Ref.get(input.selectionRequest)) as number)) return false
            const previous = (yield* Ref.get(input.interactiveThread)) as Thread.Thread | undefined
            const joined =
              input.getSelectionLoad()?.epoch === 0 && input.getSelectionLoad().threadId === id
                ? input.getSelectionLoad()
                : undefined
            input.setSelectionLoad({
              epoch,
              threadId: id,
              previousEpoch: input.getCurrentSelectionEpoch(),
              previousThreadId: previous === undefined ? undefined : String(previous.id),
              events: joined?.events ?? [],
              committed: false,
              ...(joined?.overflow === undefined ? {} : { overflow: joined.overflow }),
            })
            yield* Ref.set(input.selectionRequest, epoch)
            return true
          }),
        )
        if (!admitted) return
        const thread = yield* (yield* ThreadRepository.Service).get(Thread.ThreadId.make(id))
        if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
        yield* input.runThreadLoad(thread, epoch, input.selectionDispatch(epoch))
      }).pipe(Effect.ensuring(input.finishSelection(epoch))),
    )
  const readQueue = (id: string) =>
    input.safe(
      input.sessionDispatch,
      input.readQueue(Thread.ThreadId.make(id), input.selectionDispatch(input.getCurrentSelectionEpoch())),
    )
  const loadOlder = (
    threadId: string,
    epoch: number,
    before: TranscriptRepository.PageCursor | undefined,
    loadedKeys: ReadonlyArray<string>,
  ) =>
    input.safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        const state = input.getActiveSelectionState()
        if (!selectionMatches(state, threadId, epoch)) return
        yield* input.transcriptPageAdmission.withPermits(1)(
          input.loadTranscriptPage(state, input.selectionDispatch(state.epoch), before, new Set(loadedKeys)),
        )
      }),
    )
  const loadNewer = (threadId: string, epoch: number, after: TranscriptRepository.PageCursor) =>
    input.safe(
      input.sessionDispatch,
      input.transcriptPageAdmission.withPermits(1)(
        Effect.gen(function* () {
          const state = input.getActiveSelectionState()
          if (!selectionMatches(state, threadId, epoch)) return
          const page = yield* (yield* TranscriptRepository.Service).page(state.thread.id, { after, limit: 50 })
          if (!input.isCurrentSelectionState(state)) return
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
            (!input.isTerminalStatus(execution.status) ||
              projection === undefined ||
              projection.checkpointCursor !== execution.lastCursor)
          )
            yield* input.ensureIngest(turn.threadId, turn.id)
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
      Effect.provide(input.executionDependencies),
      Effect.scoped,
      Effect.orElseSucceed(() => undefined),
    ) as any
  const reopenThread = (epoch: number) =>
    input.safe(
      input.sessionDispatch,
      Effect.gen(function* () {
        if (!isNewerSelectionEpoch(epoch, (yield* Ref.get(input.selectionRequest)) as number)) return
        const summary = (yield* (yield* ThreadSummaryRepository.Service).list({ limit: 1 }))[0]
        if (summary === undefined) return
        const thread = yield* (yield* ThreadRepository.Service).get(summary.id)
        if (thread === undefined) return yield* operationError(`Thread ${summary.id} does not exist`)
        yield* selectThread(String(thread.id), epoch)
      }).pipe(Effect.ensuring(input.finishSelection(epoch))),
    )
  return { selectThread, readQueue, loadOlder, loadNewer, previewThread, reopenThread }
}
