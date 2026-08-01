import * as ExecutionBackend from "../../execution/contract/execution-service"
import * as ExecutionIdentifier from "@rika/product/execution-identifier"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as Turn from "../../thread/model/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "../../thread/repository/turn-repository"
import { Clock, Duration, Effect } from "effect"
import { settleStopRequestedTurns } from "./product-execution-stop"

export type AbandonedWorkStatus = "completed" | "failed" | "cancelled"

export const settleAbandonedStatus = (status: "running" | "queued" | AbandonedWorkStatus): AbandonedWorkStatus =>
  status === "running" || status === "queued" ? "cancelled" : status

export const settleAbandonedRecoveredWork = Effect.fn("ProductOperation.settleAbandonedRecoveredWork")(function* (
  grace: Duration.Duration,
  watchedThreads: () => ReadonlySet<string>,
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const bootAt = yield* Clock.currentTimeMillis
  yield* Effect.sleep(grace)
  const watched = watchedThreads()
  const abandoned = (yield* turns.listNonterminal).filter(
    (turn) => turn.status !== "queued" && turn.createdAt < bootAt && !watched.has(String(turn.threadId)),
  )
  const requestedAt = yield* Clock.currentTimeMillis
  for (const turn of abandoned) {
    yield* turns.requestStop(turn.id, requestedAt)
    yield* Effect.logInfo("execution.recovery.abandoned_stop_requested").pipe(
      Effect.annotateLogs({ "rika.turn.id": String(turn.id), "rika.thread.id": String(turn.threadId) }),
    )
  }
  if (abandoned.length > 0)
    yield* settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
      turns.setStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
    )
  if (backend.listOpenRootExecutions === undefined) return
  const openRoots = yield* backend.listOpenRootExecutions.pipe(Effect.orElseSucceed(() => []))
  for (const root of openRoots) {
    if (root.createdAt >= bootAt) continue
    const turn = root.turnId === undefined ? undefined : yield* turns.get(Turn.TurnId.make(root.turnId))
    if (
      turn !== undefined &&
      ThreadResult.TurnResult.isAgentExecution(turn) &&
      !ExecutionStatus.isTerminalStatus(turn.status)
    )
      continue
    yield* backend
      .cancel(root.executionId, ExecutionIdentifier.executionReference)
      .pipe(
        Effect.catch((failure) =>
          Effect.logWarning("execution.recovery.orphan_cancel_failed").pipe(
            Effect.annotateLogs({ "rika.execution.id": root.executionId, "rika.failure.kind": String(failure) }),
          ),
        ),
      )
    yield* Effect.logInfo("execution.recovery.orphan_cancelled").pipe(
      Effect.annotateLogs({ "rika.execution.id": root.executionId }),
    )
  }
})
