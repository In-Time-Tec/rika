import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { OperationError } from "../operation-error"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { Context, Effect, PubSub } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import { settleStopRequestedTurns } from "../../execution/lifecycle/product-execution-stop"

const interactiveEventThreadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

export const makeInteractiveSupervision = (input: any): any => {
  const {
    acquiredBackend,
    executionDependencies,
    turnChanges,
    dirtyTurnObservers,
    ensureIngest,
    setTurnStatus,
    isTerminalStatus,
    executionIngest: _executionIngest,
    notifyTurnChanged,
    claimTurnObserver: _claimTurnObserver,
    observeTurn,
    registerPromoter,
    sessionThreadViews,
    sessionId,
    getSelectedThreadId,
    interactiveSinks,
    operationFeed,
  } = input
  const backend: ExecutionBackend.Interface = acquiredBackend
  const typedTurnChanges: PubSub.PubSub<void> = turnChanges
  const typedDirtyTurnObservers: Set<Turn.TurnId> = dirtyTurnObservers
  const typedEnsureIngest: (
    threadId: Turn.Turn["threadId"],
    turnId: Turn.Turn["id"],
  ) => Effect.Effect<void, OperationError, never> = ensureIngest
  const typedSetTurnStatus: (
    id: Turn.TurnId,
    status: import("@rika/product/execution-status").Status,
    cursor: string | undefined,
    now: number,
  ) => Effect.Effect<Turn.Turn, OperationError, never> = setTurnStatus
  const typedNotifyTurnChanged: (
    turn: Pick<Turn.Turn, "id" | "threadId">,
  ) => Effect.Effect<void, OperationError, never> = notifyTurnChanged
  const typedIsTerminalStatus: (status: Turn.Turn["status"]) => boolean = isTerminalStatus
  const typedObserveTurn: (
    turn: Turn.AgentExecutionTurn,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<boolean, OperationError | ExecutionBackend.BackendError | TurnRepository.RepositoryError, never> =
    observeTurn
  const typedExecutionDependencies: Context.Context<
    TurnRepository.Service | TranscriptRepository.Service | ExecutionBackend.Service
  > = executionDependencies
  const typedOperationFeed: InteractiveOperationFeed = operationFeed
  const supervise =
    backend.follow === undefined
      ? Effect.void
      : Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* PubSub.subscribe(typedTurnChanges)
            const turns = yield* TurnRepository.Service
            const launch = (
              turn: Turn.AgentExecutionTurn,
            ): Effect.Effect<
              void,
              OperationError | ExecutionBackend.BackendError | TurnRepository.RepositoryError,
              never
            > =>
              Effect.forkChild(
                typedObserveTurn(turn, () => undefined).pipe(
                  Effect.flatMap((observed) => {
                    if (observed !== true) return Effect.void
                    return turns
                      .get(turn.id)
                      .pipe(
                        Effect.flatMap((current) =>
                          current !== undefined &&
                          ThreadResult.TurnResult.isAgentExecution(current) &&
                          typedIsTerminalStatus(current.status) !== true &&
                          current.status !== "queued"
                            ? Effect.sleep("50 millis").pipe(Effect.andThen(typedNotifyTurnChanged(current)))
                            : Effect.void,
                        ),
                      )
                  }),
                  Effect.catch((error) =>
                    Effect.logError("turn.observer.failed").pipe(
                      Effect.annotateLogs({
                        "rika.thread.id": String(turn.threadId),
                        "rika.turn.id": String(turn.id),
                        "rika.failure.kind": String(error),
                      }),
                      Effect.andThen(Effect.sleep("50 millis")),
                      Effect.andThen(typedNotifyTurnChanged(turn)),
                    ),
                  ),
                ),
              )
            const settleStopRequested = settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
              typedSetTurnStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
            )
            const recover = Effect.gen(function* () {
              const transcripts = yield* TranscriptRepository.Service
              const nonterminal = yield* turns.listNonterminal
              const projectionCandidates = yield* transcripts.listProjectionRecoveryCandidates(
                ExecutionIngest.projectionVersion,
              )
              const ensured = new Set<string>()
              for (const turn of nonterminal)
                if (turn.status !== "queued") {
                  yield* typedEnsureIngest(turn.threadId, turn.id)
                  ensured.add(String(turn.id))
                  yield* launch(turn)
                }
              for (const candidate of projectionCandidates)
                if (!ensured.has(String(candidate.turnId)))
                  yield* typedEnsureIngest(candidate.threadId, candidate.turnId)
            })
            const scanDirty = Effect.gen(function* () {
              const dirty = [...typedDirtyTurnObservers]
              typedDirtyTurnObservers.clear()
              for (const turnId of dirty) {
                const turn = yield* turns.get(turnId)
                if (
                  turn !== undefined &&
                  ThreadResult.TurnResult.isAgentExecution(turn) &&
                  typedIsTerminalStatus(turn.status) !== true &&
                  turn.status !== "queued"
                )
                  yield* launch(turn)
              }
            })
            yield* settleStopRequested
            yield* recover
            while (true) {
              yield* PubSub.take(changes)
              yield* scanDirty
            }
          }),
        ).pipe(Effect.provide(typedExecutionDependencies))
  if (registerPromoter !== true) sessionThreadViews.set(sessionId, () => getSelectedThreadId())
  if (registerPromoter !== true)
    interactiveSinks.set(sessionId, (_origin: number, event: InteractiveEvent) => {
      const threadId = interactiveEventThreadId(event)
      if (threadId !== undefined && typedOperationFeed.bufferSelectionEvent(event) === true) return
      if (
        threadId === undefined ||
        threadId === getSelectedThreadId() ||
        event._tag === "TitleCostUpdated" ||
        event._tag === "ThreadUsageUpdated"
      )
        typedOperationFeed.deliver(event, {
          selectedThreadOnly: threadId !== undefined && event._tag !== "TitleCostUpdated",
        })
    })
  return supervise
}
