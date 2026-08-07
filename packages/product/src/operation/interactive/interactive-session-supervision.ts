import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import { operationError, OperationError } from "../operation-error"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as ExecutionAuthorityReconciliation from "../../execution/lifecycle/execution-authority-reconciliation"
import { Effect, PubSub } from "effect"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type {
  InteractiveExecutionContext,
  InteractiveExecutionContextServices,
  InteractiveSessionInput,
} from "./interactive-session-runtime"
import type { makeInteractiveExecution } from "./interactive-session-execution"
import type { makeInteractiveFollowing } from "./interactive-session-following"

const interactiveEventThreadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

export interface InteractiveSupervisionInput {
  readonly acquiredBackend: ExecutionGateway.Interface
  readonly rootTurnOwner: InteractiveSessionInput["rootTurnOwner"]
  readonly executionDependencies: InteractiveExecutionContext
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<Turn.TurnId>
  readonly isTerminalStatus: InteractiveSessionInput["isTerminalStatus"]
  readonly setTurnStatus: InteractiveSessionInput["setTurnStatus"]
  readonly settleThread: ReturnType<typeof makeInteractiveExecution>["settleThread"]
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
  | ExecutionGateway.StartTurnFailure
  | ExecutionGateway.WatchTurnFailure
  | ExecutionGateway.InspectTurnFailure
  | TurnRepository.RepositoryError
  | TranscriptRepository.RepositoryError,
  never
> => {
  const {
    acquiredBackend,
    rootTurnOwner,
    executionDependencies,
    turnChanges,
    dirtyTurnObservers,
    isTerminalStatus,
    setTurnStatus,
    notifyTurnChanged,
    observeTurn,
    serverOwner,
    sessionThreadViews,
    sessionId,
    getSelectedThreadId,
    interactiveSinks,
    operationFeed,
  } = input
  // A restarted observer is the live owner after a durable wait; the server owner broadcasts without filling its
  // internal session queue, while an interactive claimant also delivers to its own feed.
  const observedDispatch = serverOwner ? (_event: InteractiveEvent) => {} : operationFeed.sessionDispatch
  const publishObserved = (event: InteractiveEvent) => operationFeed.emit(observedDispatch, event)
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
          observeTurn(turn, publishObserved).pipe(
            Effect.flatMap((observed) => {
              if (observed !== true) return Effect.void
              return turns
                .get(turn.id)
                .pipe(
                  Effect.flatMap((current) =>
                    current !== undefined &&
                    ThreadResult.TurnResult.isAgentExecution(current) &&
                    isTerminalStatus(current.status) !== true &&
                    current.status !== "queued" &&
                    current.status !== "waiting"
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
        if (serverOwner) yield* rootTurnOwner.recoverExecutionAdmissions
        const transcripts = yield* TranscriptRepository.Service
        const summaryRepository = yield* ThreadSummaryRepository.Service
        const setSettledStatus = (id: Turn.TurnId, status: ExecutionStatus.Status, now: number) =>
          setTurnStatus(id, status, now).pipe(
            Effect.provideService(TurnRepository.Service, turns),
            Effect.provideService(ThreadSummaryRepository.Service, summaryRepository),
            Effect.map((turn) => turn as Turn.AgentExecutionTurn),
          )
        const reconciled = yield* ExecutionAuthorityReconciliation.make({
          turns,
          transcripts,
          backend: acquiredBackend,
          setTurnStatus: setSettledStatus,
        }).pipe(Effect.mapError((error) => operationError(String(error), error)))
        for (const turn of reconciled.active) yield* launch(turn)
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
      if (threadId === undefined || threadId === getSelectedThreadId())
        operationFeed.deliver(event, { selectedThreadOnly: threadId !== undefined })
    })
  return supervise
}
