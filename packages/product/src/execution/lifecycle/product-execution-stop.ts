import { Function } from "effect"
import * as ExecutionBackend from "../../execution/contract/execution-service"
import * as ThreadActivity from "../../thread/query/thread-activity"
import * as Turn from "../../thread/model/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "../../thread/repository/turn-repository"
import { Clock, Effect } from "effect"

export interface ExecutionStopRequest {
  readonly executionId: string
  readonly reason: string
}

const stopRequestImpl = (executionId: string, reason: string): ExecutionStopRequest => ({ executionId, reason })

export const stopRequest: {
  (arg1: string): (arg0: string) => ReturnType<typeof stopRequestImpl>
  (arg0: string, arg1: string): ReturnType<typeof stopRequestImpl>
} = Function.dual(2, stopRequestImpl)

export const settleStopRequestedTurns = Effect.fn("ProductOperation.settleStopRequestedTurns")(function* <E, R>(
  backend: ExecutionBackend.Interface,
  settle: (
    turnId: Turn.TurnId,
    status: ExecutionStatus.Status,
    cursor: string | undefined,
    settledAt: number,
  ) => Effect.Effect<void, E, R>,
) {
  const turns = yield* TurnRepository.Service
  for (const turn of yield* turns.listStopRequested) {
    const outcome = yield* Effect.result(backend.cancel(turn.id))
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning("execution.stop.settle_cancel_failed").pipe(
        Effect.annotateLogs({ "rika.turn.id": String(turn.id), "rika.failure.kind": String(outcome.failure) }),
      )
      continue
    }
    const result = outcome.success
    yield* settle(
      turn.id,
      result.status,
      result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
      yield* Clock.currentTimeMillis,
    )
    yield* Effect.logInfo("execution.stop.settled").pipe(Effect.annotateLogs({ "rika.turn.id": String(turn.id) }))
  }
})

export const stopActiveExecutionWork = Effect.fn("ProductOperation.stopActiveExecutionWork")(function* () {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const running = (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
  const requestedAt = yield* Clock.currentTimeMillis
  for (const turn of running) yield* turns.requestStop(turn.id, requestedAt)
  if (running.length > 0)
    yield* Effect.logInfo("execution.stop.requested_for_all").pipe(
      Effect.annotateLogs({ "rika.turn.count": running.length }),
    )
  yield* settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
    turns.setStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
  )
})
