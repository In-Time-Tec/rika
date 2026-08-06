import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { OperationError } from "../operation-error"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { Effect, PubSub } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import type {
  InteractiveExecutionContext,
  InteractiveExecutionContextServices,
  InteractiveSessionInput,
} from "./interactive-session-runtime"
import type { makeInteractiveFollowing } from "./interactive-session-following"

const interactiveEventThreadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

export interface InteractiveSupervisionInput {
  readonly acquiredBackend: ExecutionGateway.Interface
  readonly executionDependencies: InteractiveExecutionContext
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<Turn.TurnId>
  readonly ensureIngest: InteractiveSessionInput["ensureIngest"]
  readonly isTerminalStatus: InteractiveSessionInput["isTerminalStatus"]
  readonly executionIngest: ExecutionIngest.Interface
  readonly notifyTurnChanged: InteractiveSessionInput["notifyTurnChanged"]
  readonly claimTurnObserver: InteractiveSessionInput["claimTurnObserver"]
  readonly observeTurn: ReturnType<typeof makeInteractiveFollowing>["observeTurn"]
  readonly serverOwner: boolean
  readonly sessionThreadViews: Map<number, () => string | undefined>
  readonly sessionId: number
  readonly getSelectedThreadId: () => string | undefined
  readonly interactiveSinks: Map<number, (origin: number, event: InteractiveEvent) => void>
  readonly operationFeed: InteractiveOperationFeed
}

export const makeInteractiveSupervision = (
  input: InteractiveSupervisionInput,
): Effect.Effect<
  void,
  | OperationError
  | ExecutionGateway.WatchTurnFailure
  | ExecutionGateway.InspectTurnFailure
  | TurnRepository.RepositoryError
  | TranscriptRepository.RepositoryError,
  never
> => {
  const {
    acquiredBackend,
    executionDependencies,
    turnChanges,
    dirtyTurnObservers,
    ensureIngest,
    isTerminalStatus,
    notifyTurnChanged,
    observeTurn,
    serverOwner,
    sessionThreadViews,
    sessionId,
    getSelectedThreadId,
    interactiveSinks,
    operationFeed,
  } = input
  const supervise = Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.subscribe(turnChanges)
      const turns = yield* TurnRepository.Service
      const launch = (
        turn: Turn.AgentExecutionTurn,
      ): Effect.Effect<
        void,
        | OperationError
        | ExecutionGateway.WatchTurnFailure
        | TurnRepository.RepositoryError
        | TranscriptRepository.RepositoryError,
        InteractiveExecutionContextServices
      > =>
        Effect.forkChild(
          observeTurn(turn, () => undefined).pipe(
            Effect.flatMap((observed) => {
              if (observed !== true) return Effect.void
              return turns
                .get(turn.id)
                .pipe(
                  Effect.flatMap((current) =>
                    current !== undefined &&
                    ThreadResult.TurnResult.isAgentExecution(current) &&
                    isTerminalStatus(current.status) !== true &&
                    current.status !== "queued"
                      ? Effect.sleep("50 millis").pipe(Effect.andThen(notifyTurnChanged(current)))
                      : Effect.void,
                  ),
                )
            }),
            Effect.catch((error) => {
              const logged = Effect.logError("turn.observer.failed").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": String(turn.threadId),
                  "rika.turn.id": String(turn.id),
                  "rika.failure.kind": error.name,
                  "rika.failure.message": error.message,
                }),
              )
              return logged
            }),
          ),
        )
      const recover = Effect.gen(function* () {
        const transcripts = yield* TranscriptRepository.Service
        const nonterminal = yield* turns.listNonterminal
        const projectionCandidates = yield* transcripts.listProjectionRecoveryCandidates(
          ExecutionIngest.projectionVersion,
        )
        const ensured = new Set<string>()
        for (const turn of nonterminal)
          if (turn.status !== "queued" && turn.executionLink !== undefined) {
            yield* ensureIngest(turn.threadId, turn.id)
            ensured.add(String(turn.id))
            const view = yield* acquiredBackend.inspectTurn(turn.executionLink)
            if (view.status !== "unavailable") yield* launch(turn)
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
            ThreadResult.TurnResult.isAgentExecution(turn) &&
            isTerminalStatus(turn.status) !== true &&
            turn.status !== "queued"
          )
            yield* launch(turn)
        }
      })
      yield* recover
      while (true) {
        yield* PubSub.take(changes)
        yield* scanDirty
      }
    }),
  ).pipe(Effect.provide(executionDependencies))
  if (serverOwner !== true) sessionThreadViews.set(sessionId, () => getSelectedThreadId())
  if (serverOwner !== true)
    interactiveSinks.set(sessionId, (_origin: number, event: InteractiveEvent) => {
      const threadId = interactiveEventThreadId(event)
      if (threadId !== undefined && operationFeed.bufferSelectionEvent(event) === true) return
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
