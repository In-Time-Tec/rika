import * as ExecutionBackend from "../../execution/contract/execution-service"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as ThreadActivity from "../../thread/query/thread-activity"
import * as Turn from "../../thread/model/turn-record"
import * as TurnRepository from "../../thread/repository/turn-repository"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import {
  awaitSessionQuiescence,
  executionTreeQuiescent,
  fanOutTurnStatus,
} from "../../execution/lifecycle/product-execution-quiescence"
import { OperationError, operationError } from "../operation-error"
import { Clock, Effect } from "effect"

const isTerminalStatus = ExecutionStatus.isTerminalStatus

export const reconcileInternal = Effect.fn("ProductOperation.reconcile")(function* (
  extensions?: ExecutionExtensions.ExecutionExtensionInterface,
  prepare?: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    | TurnRepository.Service
    | ThreadRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService
  >,
  watchReviewOwner?: (
    turn: Turn.AgentExecutionTurn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
  ownership?: {
    readonly claim: (
      turn: Pick<Turn.AgentExecutionTurn, "id" | "status">,
    ) => Effect.Effect<boolean, TurnRepository.RepositoryError, TurnRepository.Service>
    readonly release: (turnId: Turn.TurnId) => Effect.Effect<boolean>
    readonly claimQueued: (
      threadId: Thread.ThreadId,
      now: number,
    ) => Effect.Effect<TurnRepository.QueueClaim | undefined, TurnRepository.RepositoryError, TurnRepository.Service>
  },
  repairQueues: boolean = true,
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const active = yield* turns.listNonterminal
  const skipRepair = (turn: Turn.AgentExecutionTurn) =>
    Effect.logInfo("execution.repair.skipped").pipe(
      Effect.annotateLogs({
        "rika.turn.id": String(turn.id),
        "rika.turn.expected_status": turn.status,
        "rika.failure.kind": "turn-status-changed-or-observed",
      }),
    )
  yield* Effect.forEach(
    active.filter((turn) => turn.status !== "queued"),
    (turn) => {
      const repair =
        turn.reviewFanOutId !== undefined
          ? backend.inspectFanOut(turn.reviewFanOutId).pipe(
              Effect.flatMap((inspection) =>
                Effect.gen(function* () {
                  let status: Turn.Status = "failed"
                  if (inspection !== undefined) {
                    status = fanOutTurnStatus(inspection.state)
                  }
                  yield* turns.setStatus(turn.id, status, turn.lastCursor, yield* Clock.currentTimeMillis)
                  if (inspection?.state === "joining" && watchReviewOwner !== undefined)
                    yield* watchReviewOwner(turn, inspection)
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                  return yield* error
                }),
              ),
            )
          : backend.inspect(turn.id).pipe(
              Effect.flatMap((inspection) =>
                inspection === undefined
                  ? Effect.gen(function* () {
                      const now = yield* Clock.currentTimeMillis
                      if ((yield* awaitSessionQuiescence(backend, turn.threadId)) !== undefined) return
                      if (prepare === undefined && extensions !== undefined && turn.extensionPin === undefined)
                        return yield* operationError(`Turn ${turn.id} has no durable extension pin`)
                      if (prepare === undefined && extensions !== undefined && turn.extensionPin !== undefined)
                        yield* extensions.resume(turn.extensionPin)
                      const prepared =
                        prepare === undefined
                          ? { prompt: turn.prompt, promptParts: turn.promptParts, extensionPin: turn.extensionPin }
                          : yield* (yield* ThreadRepository.Service)
                              .get(turn.threadId)
                              .pipe(
                                Effect.flatMap((thread) =>
                                  thread === undefined
                                    ? operationError(`Thread ${turn.threadId} does not exist`)
                                    : prepare(turn, thread.workspace),
                                ),
                              )
                      if (turn.status === "accepted") {
                        if (!(yield* turns.startAccepted(turn.id, now))) return
                      } else {
                        const current = yield* turns.get(turn.id)
                        if (current === undefined || !Turn.isAgentExecution(current) || current.status !== turn.status)
                          return
                      }
                      const result = yield* backend.start({
                        threadId: turn.threadId,
                        turnId: turn.id,
                        prompt: prepared.prompt,
                        ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                        executionRoute: turn.executionRoute,
                        ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                      })
                      yield* turns.setStatus(
                        turn.id,
                        result.status,
                        result.checkpoint?.cursor ??
                          ThreadActivity.latestCursor(turn.id, result.events) ??
                          turn.lastCursor,
                        now,
                      )
                    }).pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                          return yield* error
                        }),
                      ),
                    )
                  : Effect.gen(function* () {
                      if (isTerminalStatus(inspection.status) && !(yield* executionTreeQuiescent(backend, turn.id)))
                        return
                      yield* turns.setStatus(
                        turn.id,
                        inspection.status,
                        inspection.lastCursor ?? turn.lastCursor,
                        yield* Clock.currentTimeMillis,
                      )
                    }),
              ),
            )
      if (ownership === undefined)
        return turns
          .get(turn.id)
          .pipe(Effect.flatMap((current) => (current?.status === turn.status ? repair : skipRepair(turn))))
      return Effect.uninterruptibleMask((restore) =>
        ownership
          .claim(turn)
          .pipe(
            Effect.flatMap((claimed) =>
              claimed ? restore(repair).pipe(Effect.ensuring(ownership.release(turn.id))) : skipRepair(turn),
            ),
          ),
      )
    },
    { discard: true },
  )
  const threadIds = [...new Set(active.map((turn) => turn.threadId))]
  if (backend.wakeThreadHost !== undefined) {
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const wake = yield* turns.requestQueueWake(threadId)
          if (wake === undefined) return
          const now = yield* Clock.currentTimeMillis
          yield* backend.wakeThreadHost!({ ...wake, now })
        }),
      { discard: true },
    )
    return
  }
  if (!repairQueues) return
  const promotionNow = yield* Clock.currentTimeMillis
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      Effect.gen(function* () {
        const queue = yield* turns.readQueue(threadId)
        const staleError = staleQueuedTurnsError(threadId, queue.turns, promotionNow, queuedTurnPromoteMaxAgeMs)
        if (staleError !== undefined) {
          yield* Effect.logWarning("execution.queue.stale_refused").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(threadId),
              "rika.turn.count": staleError.turnIds.length,
            }),
          )
          return
        }
        const thread = prepare === undefined ? undefined : yield* (yield* ThreadRepository.Service).get(threadId)
        if (prepare !== undefined && thread === undefined) return
        const executePromoted = (claim: TurnRepository.QueueClaim) =>
          Effect.gen(function* () {
            const promotedTurn = claim.turn
            const prepared = yield* prepare === undefined
              ? Effect.succeed({
                  prompt: promotedTurn.prompt,
                  promptParts: promotedTurn.promptParts,
                  extensionPin: promotedTurn.extensionPin,
                })
              : prepare(promotedTurn, thread!.workspace)
            const transition = yield* turns.finishQueuedClaim(
              claim,
              "running",
              promotedTurn.lastCursor,
              prepared.extensionPin,
              yield* Clock.currentTimeMillis,
            )
            if (transition._tag === "Unavailable") return undefined
            return yield* backend
              .start({
                threadId,
                turnId: promotedTurn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                executionRoute: promotedTurn.executionRoute,
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* turns.setStatus(
                      promotedTurn.id,
                      "failed",
                      promotedTurn.lastCursor,
                      yield* Clock.currentTimeMillis,
                    )
                    return yield* error
                  }),
                ),
              )
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const current = yield* turns.get(claim.turn.id)
                if (current?.status === "queued")
                  yield* turns.finishQueuedClaim(
                    claim,
                    "failed",
                    claim.turn.lastCursor,
                    claim.turn.extensionPin,
                    yield* Clock.currentTimeMillis,
                  )
                return yield* error
              }),
            ),
            Effect.onInterrupt(() => turns.releaseQueuedClaim(claim)),
          )
        while (true) {
          if ((yield* turns.readQueue(threadId)).queuedCount === 0) return
          if ((yield* awaitSessionQuiescence(backend, threadId)) !== undefined) return
          let promotedTurn: TurnRepository.QueueClaim
          let result: ExecutionBackend.Result
          if (ownership === undefined) {
            const promoted = yield* turns.claimNextQueued(threadId, yield* Clock.currentTimeMillis)
            if (promoted === undefined) return
            promotedTurn = promoted
            const executionResult = yield* executePromoted(promoted)
            if (executionResult === undefined) continue
            result = executionResult
          } else {
            const repaired = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const promoted = yield* ownership.claimQueued(threadId, yield* Clock.currentTimeMillis)
                if (promoted === undefined) return undefined
                const executionResult = yield* restore(executePromoted(promoted)).pipe(
                  Effect.ensuring(ownership.release(promoted.turn.id)),
                )
                return { promoted, result: executionResult }
              }),
            )
            if (repaired === undefined) return
            if (repaired.result === undefined) continue
            promotedTurn = repaired.promoted
            result = repaired.result
          }
          yield* turns.setStatus(
            promotedTurn.turn.id,
            result.status,
            result.checkpoint?.cursor ??
              ThreadActivity.latestCursor(promotedTurn.turn.id, result.events) ??
              promotedTurn.turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          if (!isTerminalStatus(result.status) || result.status === "failed") return
        }
      }),
    { discard: true },
  )
})
export const reconcile = Effect.fn("ProductOperation.reconcilePublic")(function* (
  extensions?: ExecutionExtensions.ExecutionExtensionInterface,
  prepare?: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    | TurnRepository.Service
    | ThreadRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService
  >,
  watchReviewOwner?: (
    turn: Turn.AgentExecutionTurn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
): Effect.fn.Return<
  void,
  OperationError,
  | ExecutionBackend.Service
  | TurnRepository.Service
  | ThreadRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.ExecutionExtensionService
> {
  return yield* reconcileInternal(extensions, prepare, watchReviewOwner).pipe(
    Effect.mapError((error) => operationError(String(error))),
  )
})
