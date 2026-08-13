import * as Turn from "@rika/product/turn-record"
import * as Thread from "@rika/product/thread-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import { operationError, OperationError } from "../operation-error"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as ExecutionAuthorityReconciliation from "../../execution/lifecycle/execution-authority-reconciliation"
import { Cause, Effect, Fiber, PubSub } from "effect"
import { makeFailure } from "../operation-failure"
import type { SteeringAdmissionRejection } from "../../thread/queue/root-turn-owner"
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
  readonly queueMutationEvent: InteractiveSessionInput["queueMutationEvent"]
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
    settleThread,
    notifyTurnChanged,
    observeTurn,
    serverOwner,
    sessionThreadViews,
    sessionId,
    getSelectedThreadId,
    interactiveSinks,
    operationFeed,
    queueMutationEvent,
  } = input
  const observedDispatch = serverOwner ? (_event: InteractiveEvent) => {} : operationFeed.sessionDispatch
  const publishObserved = (event: InteractiveEvent) => operationFeed.emit(observedDispatch, event)
  const publishSteeringRejection = (rejection: SteeringAdmissionRejection) => {
    if (rejection.queue !== undefined) publishObserved(queueMutationEvent(rejection.queue))
    publishObserved({
      _tag: "ExecutionControlFailed",
      selectionEpoch: 0,
      threadId: Thread.ThreadId.make(rejection.admission.target.threadId),
      turnId: Turn.TurnId.make(rejection.admission.target.turnId),
      action: "steer",
      failure: makeFailure(Cause.fail(rejection.failure)),
      steeringRequestId: rejection.admission.input.idempotencyKey,
    })
  }
  const supervise = Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.subscribe(turnChanges)
      const turns = yield* TurnRepository.Service
      const steeringChanges = yield* PubSub.sliding<void>(1)
      const steeringSignals = yield* PubSub.subscribe(steeringChanges)
      let retryDelay = 100
      let retryFiber: Fiber.Fiber<void> | undefined
      const scheduleSteeringRetry = Effect.suspend(() => {
        if (retryFiber !== undefined) return Effect.void
        return Effect.forkChild(
          Effect.sleep(retryDelay).pipe(Effect.andThen(PubSub.publish(steeringChanges, undefined)), Effect.asVoid),
        ).pipe(
          Effect.tap((fiber) => Effect.sync(() => (retryFiber = fiber))),
          Effect.asVoid,
        )
      })
      const steeringRecovery = Effect.forever(
        Effect.gen(function* () {
          yield* PubSub.take(steeringSignals)
          if (retryFiber !== undefined) {
            const fiber = retryFiber
            retryFiber = undefined
            yield* Fiber.interrupt(fiber)
          }
          const recovered = yield* Effect.exit(rootTurnOwner.recoverSteeringAdmissions)
          if (recovered._tag === "Failure") {
            yield* Effect.logError("steering.recovery.failed").pipe(
              Effect.annotateLogs({ "rika.failure.message": String(recovered.cause) }),
            )
            yield* scheduleSteeringRetry
            retryDelay = Math.min(retryDelay * 2, 5_000)
            return
          }
          for (const acceptance of recovered.value.accepted) {
            if (acceptance.notify)
              yield* notifyTurnChanged({
                id: Turn.TurnId.make(acceptance.admission.target.turnId),
                threadId: Thread.ThreadId.make(acceptance.admission.target.threadId),
              })
          }
          for (const completed of recovered.value.completed) {
            if (completed.queue !== undefined) publishObserved(queueMutationEvent(completed.queue))
          }
          for (const rejection of recovered.value.rejected) {
            const handled = yield* Effect.exit(
              Effect.gen(function* () {
                if (rejection.notify) publishSteeringRejection(rejection)
                if (rejection.queue !== undefined && rejection.admission.source !== undefined) {
                  const threads = yield* ThreadRepository.Service
                  const thread = yield* threads.get(rejection.queue.threadId)
                  if (thread !== undefined) yield* Effect.forkChild(settleThread(thread, publishObserved))
                }
                yield* rootTurnOwner.acknowledgeSteeringRejection(rejection.admission.input.idempotencyKey)
              }),
            )
            if (handled._tag === "Failure")
              yield* Effect.logError("steering.rejection.failed").pipe(
                Effect.annotateLogs({ "rika.failure.message": String(handled.cause) }),
              )
          }
          if (recovered.value.pending) {
            yield* scheduleSteeringRetry
            retryDelay = Math.min(retryDelay * 2, 5_000)
          } else {
            retryDelay = 100
          }
        }),
      )
      yield* Effect.forkChild(steeringRecovery)
      const launchSteeringRecovery = PubSub.publish(steeringChanges, undefined).pipe(Effect.asVoid)
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
              return launchSteeringRecovery.pipe(
                Effect.andThen(turns.get(turn.id)),
                Effect.flatMap((current) =>
                  current !== undefined &&
                  current._tag === "AgentExecution" &&
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
        if (serverOwner) {
          yield* rootTurnOwner.recoverExecutionAdmissions
          yield* launchSteeringRecovery
        }
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
        if (serverOwner) yield* launchSteeringRecovery
        const dirty = [...dirtyTurnObservers]
        dirtyTurnObservers.clear()
        for (const turnId of dirty) {
          const turn = yield* turns.get(turnId)
          if (
            turn !== undefined &&
            turn._tag === "AgentExecution" &&
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
