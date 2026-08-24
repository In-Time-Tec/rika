import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ResolvedContext from "../../../context/resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import type * as RootTurnOwner from "../../../thread/queue/root-owner"
import * as ExecutionAuthorityReconciliation from "../../../execution/authority/reconciliation"
import { Clock, Effect, Cause, Deferred, Duration, Fiber, PubSub, Schedule } from "effect"
import { isTerminalStatus } from "../../../execution/session/status"
import { OperationError, operationError } from "../../error"
import { type InteractiveEvent } from "../session-event"
import { type InteractiveOperationFeed } from "../view/feed"
import { makeFailure } from "../../failure"
import { type SteeringAdmissionRejection } from "../../../thread/queue/root-owner"
import {
  type InteractiveExecutionContext,
  type InteractiveExecutionContextServices,
  type InteractiveSessionInput,
  type makeInteractiveExecution,
} from "../session"
import type { InteractiveSupervisionError } from "../session-contract"

export const watchRootTurn = (input: {
  readonly turnId: Turn.TurnId
  readonly turns: TurnRepository.Interface
  readonly owner: RootTurnOwner.Interface
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    Turn.Turn,
    OperationError | ThreadSummaryRepository.RepositoryError | TurnRepository.RepositoryError,
    ThreadSummaryRepository.Service | TurnRepository.Service
  >
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<
    void,
    never,
    | ResolvedContext.Service
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
  readonly threadForTurn: (
    turn: Turn.Turn,
  ) => Effect.Effect<Thread.Thread, OperationError | ThreadRepository.RepositoryError, never>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly now: Effect.Effect<number>
}) =>
  Effect.gen(function* () {
    const turn = yield* input.turns.get(input.turnId)
    if (turn === undefined) return yield* operationError(`Turn ${input.turnId} does not exist`)
    if (!ThreadResult.TurnResult.isAgentExecution(turn))
      return yield* operationError(`Recorded shell turn ${input.turnId} cannot be watched as an execution`)
    const thread = yield* input.threadForTurn(turn)
    const clock = yield* Clock.Clock
    const publishChange = (change: ExecutionProjection.Change) => {
      input.dispatch({
        _tag: "ExecutionProjectionChanged",
        threadId: turn.threadId,
        turn: { ...turn, status: change.state.status, updatedAt: clock.currentTimeMillisUnsafe() },
        change,
      })
    }
    const publishPreview = (preview: ExecutionGateway.ModelPreviewEvent) => {
      input.dispatch({
        _tag: "ExecutionModelPreviewChanged",
        threadId: turn.threadId,
        turnId: turn.id,
        preview,
      })
    }
    const result = yield* input.owner.watchTurn(turn.id, publishChange, publishPreview)
    if (turn.status !== result.status) yield* input.setTurnStatus(turn.id, result.status, yield* input.now)
    if (isTerminalStatus(result.status)) yield* input.settleThread(thread, input.dispatch)
  })

export const observeRootTurn = (input: {
  readonly turn: Turn.AgentExecutionTurn
  readonly claim: (
    turnId: Turn.TurnId,
    expectedStatus?: ExecutionStatus.Status,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError, never>
  readonly release: (turnId: Turn.TurnId, notify?: boolean) => Effect.Effect<void, OperationError, never>
  readonly watch: Effect.Effect<
    void,
    | OperationError
    | ExecutionGateway.WatchTurnFailure
    | TurnRepository.RepositoryError
    | TranscriptRepository.RepositoryError
    | ThreadSummaryRepository.RepositoryError
    | ThreadRepository.RepositoryError,
    | ExecutionGateway.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ResolvedContext.Service
    | ThreadRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
}) =>
  input.turn.executionLink === undefined
    ? Effect.succeed(false)
    : Effect.uninterruptibleMask((restore) =>
        input
          .claim(input.turn.id, isTerminalStatus(input.turn.status) ? input.turn.status : undefined)
          .pipe(
            Effect.flatMap((claimed) =>
              !claimed
                ? Effect.succeed(false)
                : restore(input.watch).pipe(
                    Effect.as(true),
                    Effect.ensuring(input.release(input.turn.id, false).pipe(Effect.ignore)),
                  ),
            ),
          ),
      )

export const ignoreInteractiveEvent = (_event: InteractiveEvent) => {}

export interface InteractiveFollowingInput {
  readonly rootTurnOwner: RootTurnOwner.Interface
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    Turn.Turn,
    OperationError | ThreadSummaryRepository.RepositoryError | TurnRepository.RepositoryError,
    ThreadSummaryRepository.Service | TurnRepository.Service
  >
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<
    void,
    never,
    | ResolvedContext.Service
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
  readonly threadForTurn: (
    turn: Turn.Turn,
  ) => Effect.Effect<Thread.Thread, OperationError | ThreadRepository.RepositoryError, never>
  readonly claimTurnObserver: (
    turnId: Turn.TurnId,
    expectedStatus?: ExecutionStatus.Status,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError, never>
  readonly releaseTurnObserver: (turnId: Turn.TurnId, notify?: boolean) => Effect.Effect<void, never, never>
}

export const makeInteractiveFollowing = (input: InteractiveFollowingInput) => {
  const { rootTurnOwner, setTurnStatus, settleThread, threadForTurn, claimTurnObserver, releaseTurnObserver } = input
  const watchClaimedTurn = Effect.fn("ProductOperation.interactive.watchClaimedTurn")(function* (
    turnId: Turn.TurnId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
    return yield* watchRootTurn({
      turnId,
      turns,
      owner: rootTurnOwner,
      setTurnStatus,
      settleThread,
      threadForTurn,
      dispatch,
      now: Clock.currentTimeMillis,
    })
  })
  const observeTurn = Effect.fn("ProductOperation.interactive.observeTurn")(function* (
    turn: Turn.AgentExecutionTurn,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    return yield* observeRootTurn({
      turn,
      claim: claimTurnObserver,
      release: releaseTurnObserver,
      watch: watchClaimedTurn(turn.id, dispatch),
    })
  })
  return { watchClaimedTurn, observeTurn }
}

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
  readonly recoveryOwner: boolean
  readonly sessionThreadViews: Map<number, () => string | undefined>
  readonly sessionId: number
  readonly getSelectedThreadId: () => string | undefined
  readonly interactiveSinks: Map<number, (origin: number, event: InteractiveEvent) => void>
  readonly operationFeed: InteractiveOperationFeed
  readonly queueMutationEvent: InteractiveSessionInput["queueMutationEvent"]
  readonly initialized: Deferred.Deferred<void, InteractiveSupervisionError>
}

export const makeInteractiveSupervision = (
  input: InteractiveSupervisionInput,
): Effect.Effect<void, InteractiveSupervisionError, never> => {
  const {
    acquiredBackend,
    rootTurnOwner,
    executionDependencies,
    turnChanges,
    dirtyTurnObservers,
    isTerminalStatus: terminalStatus,
    setTurnStatus,
    settleThread,
    notifyTurnChanged,
    observeTurn,
    recoveryOwner,
    sessionThreadViews,
    sessionId,
    getSelectedThreadId,
    interactiveSinks,
    operationFeed,
    queueMutationEvent,
    initialized,
  } = input
  const observedDispatch = recoveryOwner ? (_event: InteractiveEvent) => {} : operationFeed.sessionDispatch
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
          for (const completed of recovered.value.completed) {
            if (completed.queue !== undefined) publishObserved(queueMutationEvent(completed.queue))
            if (completed.notify)
              yield* notifyTurnChanged({
                id: Turn.TurnId.make(completed.admission.target.turnId),
                threadId: Thread.ThreadId.make(completed.admission.target.threadId),
              })
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
        if (recoveryOwner) {
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
        const threads = yield* ThreadRepository.Service
        for (const threadId of new Set(reconciled.settledThreads)) {
          const thread = yield* threads
            .get(threadId)
            .pipe(Effect.mapError((error) => operationError(String(error), error)))
          if (thread !== undefined) yield* settleThread(thread, publishObserved)
        }
      })
      const scanDirty = Effect.gen(function* () {
        if (recoveryOwner) yield* launchSteeringRecovery
        const dirty = [...dirtyTurnObservers]
        dirtyTurnObservers.clear()
        for (const turnId of dirty) {
          const turn = yield* turns.get(turnId)
          if (
            turn !== undefined &&
            turn._tag === "AgentExecution" &&
            terminalStatus(turn.status) !== true &&
            turn.status !== "queued"
          )
            yield* launch(turn)
        }
      })
      const initial = yield* Effect.exit(recover)
      yield* Deferred.done(initialized, initial)
      if (initial._tag === "Failure") return yield* Effect.failCause(initial.cause)
      while (true) {
        yield* PubSub.take(changes)
        yield* scanDirty
      }
    }),
  ).pipe(
    Effect.provide(executionDependencies),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("interactive.supervision.failed").pipe(
            Effect.annotateLogs({ "rika.failure.message": Cause.pretty(cause) }),
          ),
    ),
    Effect.retry(
      Schedule.exponential("100 millis").pipe(
        Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5)))),
      ),
    ),
  )
  if (recoveryOwner !== true) sessionThreadViews.set(sessionId, () => getSelectedThreadId())
  if (recoveryOwner !== true)
    interactiveSinks.set(sessionId, (_origin: number, event: InteractiveEvent) => {
      const threadId = interactiveEventThreadId(event)
      if (threadId !== undefined && operationFeed.bufferSelectionEvent(event) === true) return
      if (threadId === undefined || threadId === getSelectedThreadId())
        operationFeed.deliver(event, { selectedThreadOnly: threadId !== undefined })
    })
  return supervise
}
