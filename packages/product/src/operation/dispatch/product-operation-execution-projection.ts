import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Clock, Effect, PubSub } from "effect"
import { operationError } from "../operation-error"
import type { InteractiveEvent } from "../interactive/interactive-event"

export const makeExecutionProjection = (input: any) =>
  Effect.sync(() => {
    const { dirtyTurnObservers, turnChanges, notifyThreadSummaries } = input
    const typedProjectExecutionResult: (
      threadId: Turn.Turn["threadId"],
      result: ExecutionEvent.Result,
    ) => Effect.Effect<void, import("../operation-error").OperationError, never> = input.projectExecutionResult
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
      yield* notifyThreadSummaries
      yield* notifyTurnChanged(turn)
    })
    const projectExecutionResult = Effect.fn("ProductOperation.projectExecutionResult")(function* (
      threadId: Thread.ThreadId,
      result: ExecutionEvent.Result,
    ) {
      const summaries = yield* ThreadSummaryRepository.Service
      yield* summaries.replaceTurn(ThreadActivity.projectionInput(threadId, result, yield* Clock.currentTimeMillis))
      yield* notifyThreadSummaries
    })
    const setTurnStatus = Effect.fn("ProductOperation.setTurnStatus")(function* (
      id: Turn.TurnId,
      status: ExecutionStatus.Status,
      lastCursor: string | undefined,
      now: number,
    ) {
      const turns = yield* TurnRepository.Service
      const turn = yield* turns.setStatus(id, status, lastCursor, now)
      yield* notifyThreadSummaries
      yield* notifyTurnChanged(turn)
      return turn
    })
    const repairThreadSummaries = Effect.fn("ProductOperation.repairThreadSummaries")(function* () {
      const summaries = yield* ThreadSummaryRepository.Service
      const backend = yield* ExecutionBackend.Service
      let previousBatch: ReadonlyArray<readonly [string, string, string | undefined]> = []
      while (true) {
        const candidates = yield* summaries.listRepairCandidates(100)
        if (candidates.length === 0) return
        const batch = candidates.map((candidate) => [candidate.turnId, candidate.status, candidate.lastCursor] as const)
        if (
          batch.length === previousBatch.length &&
          batch.every(
            (candidate, index) =>
              candidate[0] === previousBatch[index]?.[0] &&
              candidate[1] === previousBatch[index]?.[1] &&
              candidate[2] === previousBatch[index]?.[2],
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
              const inspection = yield* backend.inspect(candidate.turnId)
              if (inspection === undefined) {
                yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
                return
              }
              const result = yield* backend.replay(candidate.turnId)
              const turns = yield* TurnRepository.Service
              const current = yield* turns.get(candidate.turnId)
              if (
                current === undefined ||
                !ThreadResult.TurnResult.isAgentExecution(current) ||
                current.status !== candidate.status ||
                current.lastCursor !== candidate.lastCursor
              )
                return
              if (
                result.status !== candidate.status ||
                !(yield* turns.repairCursor(
                  candidate.turnId,
                  candidate.status,
                  candidate.lastCursor,
                  ThreadActivity.latestCursor(candidate.turnId, result.events) ?? candidate.lastCursor,
                ))
              )
                return
              yield* typedProjectExecutionResult(candidate.threadId, result)
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
    })
    return {
      notifyTurnChanged,
      dispatchThreadSummaries,
      ensureTurnSummary,
      projectExecutionResult,
      setTurnStatus,
      repairThreadSummaries,
    }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
