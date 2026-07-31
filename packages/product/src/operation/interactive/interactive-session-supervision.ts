import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { Effect, PubSub } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import { settleStopRequestedTurns } from "../dispatch/execution-operation-coordination"

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
  const backend = acquiredBackend
  const supervise =
    acquiredBackend.follow === undefined
      ? Effect.void
      : Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* PubSub.subscribe(turnChanges)
            const turns = yield* TurnRepository.Service
            const launch = (turn: Turn.AgentExecutionTurn) =>
              Effect.forkChild(
                observeTurn(turn, () => undefined).pipe(
                  Effect.flatMap((observed) => {
                    if (!observed) return Effect.void
                    return turns
                      .get(turn.id)
                      .pipe(
                        Effect.flatMap((current) =>
                          current !== undefined &&
                          Turn.isAgentExecution(current) &&
                          !isTerminalStatus(current.status) &&
                          current.status !== "queued"
                            ? Effect.sleep("50 millis").pipe(Effect.andThen(notifyTurnChanged(current)))
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
                      Effect.andThen(notifyTurnChanged(turn)),
                    ),
                  ),
                ),
              )
            const settleStopRequested = settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
              setTurnStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
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
                  yield* ensureIngest(turn.threadId, turn.id)
                  ensured.add(String(turn.id))
                  yield* launch(turn)
                }
              for (const candidate of projectionCandidates)
                if (!ensured.has(String(candidate.turnId))) yield* ensureIngest(candidate.threadId, candidate.turnId)
            })
            const scanDirty = Effect.gen(function* () {
              const dirty = [...dirtyTurnObservers]
              dirtyTurnObservers.clear()
              for (const turnId of dirty) {
                const turn = yield* turns.get(turnId)
                if (
                  turn !== undefined &&
                  Turn.isAgentExecution(turn) &&
                  !isTerminalStatus(turn.status) &&
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
        ).pipe(Effect.provide(executionDependencies))
  if (!registerPromoter) sessionThreadViews.set(sessionId, () => getSelectedThreadId())
  if (!registerPromoter)
    interactiveSinks.set(sessionId, (_origin: number, event: InteractiveEvent) => {
      const threadId = interactiveEventThreadId(event)
      if (threadId !== undefined && operationFeed.bufferSelectionEvent(event)) return
      if (
        threadId === undefined ||
        threadId === getSelectedThreadId() ||
        event._tag === "TitleCostUpdated" ||
        event._tag === "ThreadUsageUpdated"
      )
        operationFeed.deliver(event, {
          selectedThreadOnly: threadId !== undefined && event._tag !== "TitleCostUpdated",
        })
    })
  return supervise
}
