import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Clock, Effect, PubSub } from "effect"
import { operationError } from "../operation-error"
import type { InteractiveEvent } from "../interactive/interactive-event"

export const makeExecutionProjection = (input: {
  readonly dirtyTurnObservers: Set<Turn.TurnId>
  readonly turnChanges: PubSub.PubSub<void>
  readonly notifyThreadSummaries: Effect.Effect<
    void,
    ThreadSummaryRepository.RepositoryError,
    ThreadSummaryRepository.Service
  >
  readonly publishTurnSettled?: (turn: Turn.Turn, responseArrived?: boolean) => Effect.Effect<void, never, never>
}) =>
  Effect.sync(() => {
    const { dirtyTurnObservers, turnChanges } = input
    const notifyTurnChanged = (turn: Pick<Turn.Turn, "id" | "threadId">) =>
      Effect.sync(() => dirtyTurnObservers.add(turn.id)).pipe(
        Effect.andThen(PubSub.publish(turnChanges, undefined)),
        Effect.asVoid,
      )
    const dispatchThreadSummaries = Effect.fn("ProductOperation.dispatchThreadSummaries")(function* (
      dispatch: (event: InteractiveEvent) => void,
    ) {
      const summaries = yield* ThreadSummaryRepository.Service
      dispatch({ _tag: "ThreadsListed", threads: yield* summaries.list() })
    })
    const ensureTurnSummary = Effect.fn("ProductOperation.ensureTurnSummary")(function* (turn: Turn.Turn) {
      const summaries = yield* ThreadSummaryRepository.Service
      yield* summaries.ensureTurn(turn.id, turn.threadId, turn.updatedAt)
      yield* input.notifyThreadSummaries
      yield* notifyTurnChanged(turn)
    })
    const projectExecutionResult = Effect.fn("ProductOperation.projectExecutionResult")(function* (
      threadId: Thread.ThreadId,
      result: ExecutionEvent.Result,
    ) {
      const summaries = yield* ThreadSummaryRepository.Service
      yield* summaries.replaceTurn(ThreadActivity.projectionInput(threadId, result, yield* Clock.currentTimeMillis))
      yield* input.notifyThreadSummaries
    })
    const setTurnStatus = Effect.fn("ProductOperation.setTurnStatus")(function* (
      id: Turn.TurnId,
      status: ExecutionStatus.Status,
      now: number,
      responseArrived?: boolean,
    ) {
      const turns = yield* TurnRepository.Service
      const turn = yield* turns.setStatus(id, status, now)
      yield* input.notifyThreadSummaries
      yield* notifyTurnChanged(turn)
      if (status === "completed" || status === "failed" || status === "cancelled")
        yield* input.publishTurnSettled?.(turn, responseArrived) ?? Effect.void
      return turn
    })
    const repairThreadSummaries = Effect.gen(function* () {
      const summaries = yield* ThreadSummaryRepository.Service
      let previousBatch: ReadonlyArray<readonly [string, string]> = []
      while (true) {
        const candidates = yield* summaries.listRepairCandidates(100)
        if (candidates.length === 0) return
        const batch = candidates.map((candidate) => [candidate.turnId, candidate.status] as const)
        if (
          batch.length === previousBatch.length &&
          batch.every(
            (candidate, index) =>
              candidate[0] === previousBatch[index]?.[0] && candidate[1] === previousBatch[index]?.[1],
          )
        )
          return
        previousBatch = batch
        yield* Effect.forEach(
          candidates,
          (candidate) =>
            Effect.gen(function* () {
              if (candidate.status === "queued") {
                yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
                return
              }
              yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
            }).pipe(
              Effect.catch((error) =>
                Effect.logError("thread-summary.repair.failed").pipe(
                  Effect.annotateLogs("rika.turn.id", candidate.turnId),
                  Effect.annotateLogs("rika.failure.kind", String(error)),
                ),
              ),
            ),
          { concurrency: 4, discard: true },
        )
      }
    }).pipe(Effect.withSpan("ProductOperation.repairThreadSummaries"))
    return {
      notifyTurnChanged,
      dispatchThreadSummaries,
      ensureTurnSummary,
      projectExecutionResult,
      setTurnStatus,
      repairThreadSummaries,
    }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
