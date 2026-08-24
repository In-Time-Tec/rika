import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Effect, Fiber, Scope, Semaphore, Function, Predicate, Schema, Ref } from "effect"
import { OperationUnavailable } from "../contract/product"
import { type InteractiveEvent } from "./session-event"
import * as OperationFailure from "../failure"
import { OperationError } from "../error"
import * as InteractiveFeed from "./view/feed"
import * as InteractiveSelection from "./view/selection"

type InteractiveOperationFeed = InteractiveFeed.InteractiveOperationFeed
type SelectionLoad = InteractiveFeed.SelectionLoad
type SelectionEpochState = InteractiveSelection.SelectionEpochState
type InteractiveFailureCause = Parameters<typeof OperationFailure.makeFailure>[0]

export const selectionInitialTurnWindow = 6
export const selectionInitialEntryWindow = 120

export const makeInteractiveSessionComposition = (input: {
  readonly admission: Semaphore.Semaphore
  readonly scope: Scope.Scope
  readonly closed: OperationUnavailable
  readonly isOpen: () => boolean
  readonly isAttached: () => boolean
  readonly setAttached: (attached: boolean) => void
}) => {
  const admit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
    input.admission
      .withPermits(1)(Effect.suspend(() => (input.isOpen() ? Effect.succeed(effect) : Effect.fail(input.closed))))
      .pipe(Effect.flatten)
  const runOwned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.forkIn(effect, input.scope).pipe(
      Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))),
    )
  const admitLocal = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
    effect.pipe(runOwned, admit)
  const attachFeed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
    input.admission
      .withPermits(1)(
        Effect.suspend(() => {
          if (!input.isOpen()) return Effect.fail(input.closed)
          if (input.isAttached())
            return Effect.fail(
              OperationUnavailable.make({
                operation: "InteractiveSession.events",
                message: "Interactive session already has an event consumer",
              }),
            )
          input.setAttached(true)
          return Effect.succeed(runOwned(effect.pipe(Effect.ensuring(Effect.sync(() => input.setAttached(false))))))
        }),
      )
      .pipe(Effect.flatten)
  return { admit, admitLocal, attachFeed, runOwned }
}

const dispatchInteractiveFailureImpl = (
  dispatch: (event: InteractiveEvent) => void,
  error: InteractiveFailureCause,
  threadId?: Thread.ThreadId,
  turnId?: Turn.TurnId,
) => {
  if (Schema.is(TurnRepository.QueueFull)(error))
    return dispatch({
      _tag: "QueueFull",
      selectionEpoch: 0,
      threadId: error.threadId,
      capacity: error.capacity,
      count: error.count,
    })
  const failure = OperationFailure.makeFailure(error)
  let event: Extract<InteractiveEvent, { readonly _tag: "ExecutionFailed" }> = {
    _tag: "ExecutionFailed",
    selectionEpoch: 0,
    failure,
  }
  if (threadId !== undefined) event = { ...event, threadId }
  if (turnId !== undefined) event = { ...event, turnId }
  return dispatch(event)
}

export const dispatchInteractiveFailure: {
  (
    error: InteractiveFailureCause,
    threadId?: Thread.ThreadId,
    turnId?: Turn.TurnId,
  ): (dispatch: (event: InteractiveEvent) => void) => void
  (
    dispatch: (event: InteractiveEvent) => void,
    error: InteractiveFailureCause,
    threadId?: Thread.ThreadId,
    turnId?: Turn.TurnId,
  ): void
} = Function.dual((args) => Predicate.isFunction(args[0]), dispatchInteractiveFailureImpl)

export interface InteractiveSessionState {
  readonly operationFeed: InteractiveOperationFeed
  readonly composition: ReturnType<typeof makeInteractiveSessionComposition>
  readonly lifecycleAdmission: Semaphore.Semaphore
  readonly sessionScope: Scope.Scope
  readonly emit: InteractiveOperationFeed["emit"]
  readonly getLifecycle: () => "open" | "closed"
  readonly setLifecycle: (value: "open" | "closed") => void
  readonly getCurrentSelectionEpoch: () => number
  readonly getSelectedThreadId: () => string | undefined
  readonly getActiveSelectionState: () => SelectionEpochState | undefined
  readonly dispatchFailure: typeof dispatchInteractiveFailure
  readonly selectionDispatch: InteractiveOperationFeed["selectionDispatch"]
  readonly sessionDispatch: InteractiveOperationFeed["sessionDispatch"]
  readonly selectionRequest: Ref.Ref<number>
  readonly interactiveThread: Ref.Ref<Thread.Thread | undefined>
  readonly getSelectionLoad: () => SelectionLoad | undefined
  readonly setSelectionLoad: (value: SelectionLoad | undefined) => void
  readonly getSelectionLoadFiber: () => Fiber.Fiber<unknown, unknown> | undefined
  readonly setSelectionLoadFiber: (value: Fiber.Fiber<unknown, unknown> | undefined) => void
  readonly setCurrentSelectionEpoch: (value: number) => void
  readonly setSelectedThreadId: (value: string | undefined) => void
  readonly getCandidateSelectionState: () => SelectionEpochState | undefined
  readonly setCandidateSelectionState: (value: SelectionEpochState | undefined) => void
  readonly setActiveSelectionState: (value: SelectionEpochState | undefined) => void
  readonly selectionBackground: Array<Fiber.Fiber<unknown, unknown>>
  readonly isCurrentSelectionState: (state: SelectionEpochState) => boolean
  readonly finishSelection: (epoch: number) => Effect.Effect<void, never, never>
  readonly interruptSelectionBackground: Effect.Effect<void, never, never>
  readonly interruptSelectionLoad: Effect.Effect<void, never, never>
  readonly openSelectionProjectionFeed: (state: SelectionEpochState) => Effect.Effect<void, OperationError, never>
  readonly startSelectionProjectionFeed: (
    state: SelectionEpochState,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never, never>
  readonly closeCandidateProjectionFeed: (state: SelectionEpochState) => Effect.Effect<void, never, never>
  readonly activateCreatedThread: (
    thread: Thread.Thread,
    epoch: number,
    dispatch: (event: InteractiveEvent) => void,
    activeTurn?: Turn.Turn,
    preparedQueue?: import("@rika/product/turn-repository").QueueSnapshot,
  ) => Effect.Effect<void, OperationError | TurnRepository.RepositoryError, TurnRepository.Service>
  readonly selectionAdmission: Semaphore.Semaphore
  readonly transcriptPageAdmission: Semaphore.Semaphore
  readonly submissionAdmission: Semaphore.Semaphore
  readonly sessionClosed: OperationUnavailable
}

export interface InteractiveSessionStateInput {
  readonly sessionId: number
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly activitySequence: number
  readonly initialThreadId: string | undefined
  readonly recoveryOwner: boolean
  readonly options: import("../foundation/options").ProductLayerOptions<
    Error,
    Error,
    Error,
    Error,
    Error
  >
}

export const makeInteractiveSessionState = (
  input: InteractiveSessionStateInput,
): Effect.Effect<InteractiveSessionState, never, never> =>
  Effect.gen(function* () {
    const { sessionId, publishInteractiveActivity, activitySequence, initialThreadId } = input
    let selectedThreadId = initialThreadId
    let currentSelectionEpoch = 0
    let selectionLoad: import("./view/feed").SelectionLoad | undefined =
      initialThreadId === undefined
        ? undefined
        : {
            epoch: 0,
            threadId: initialThreadId,
            previousEpoch: 0,
            previousThreadId: undefined,
            events: [],
            committed: false,
          }
    let activeSelectionState: SelectionEpochState | undefined
    let candidateSelectionState: SelectionEpochState | undefined
    const dispatchFailure = dispatchInteractiveFailure
    const submissionAdmission = yield* Semaphore.make(1)
    const interactiveThread = yield* Ref.make<Thread.Thread | undefined>(undefined)
    const selectionRequest = yield* Ref.make(0)
    const isCurrentSelectionState = (state: SelectionEpochState) =>
      activeSelectionState === state || candidateSelectionState === state
    const transcriptPageAdmission = yield* Semaphore.make(1)
    const selectionAdmission = yield* Semaphore.make(1)
    const lifecycleAdmission = yield* Semaphore.make(1)
    const sessionScope = yield* Scope.make()
    const operationFeed = yield* InteractiveFeed.makeInteractiveOperationFeed({
      sessionId,
      sessionScope,
      publishActivity: publishInteractiveActivity,
      selectionAdmission,
      selectionRequest,
      selectionLoad: { get: () => selectionLoad, set: (value) => (selectionLoad = value) },
      currentEpoch: () => currentSelectionEpoch,
    })
    const selectionDispatch = operationFeed.selectionDispatch
    const emit = operationFeed.emit
    const sessionDispatch = operationFeed.sessionDispatch
    const finishSelection = (epoch: number) =>
      selectionAdmission.withPermits(1)(
        Effect.gen(function* () {
          const loading = selectionLoad
          if (loading === undefined || loading.epoch !== epoch || loading.committed) return
          selectionLoad = undefined
          const restored = yield* Ref.modify(selectionRequest, (current) =>
            current === epoch ? [true, loading.previousEpoch] : [false, current],
          )
          if (!restored) return
          if (candidateSelectionState?.epoch === epoch) candidateSelectionState = undefined
          if (loading.previousThreadId !== loading.threadId) return
          operationFeed.releaseSelectionEvents(
            loading.previousEpoch,
            "Reload activity exceeded its bounded live window",
          )
        }),
      )
    let selectionBackground: Array<Fiber.Fiber<unknown, unknown>> = []
    let selectionLoadFiber: Fiber.Fiber<unknown, unknown> | undefined
    const interruptSelectionBackground = Effect.suspend(() => {
      const fibers = selectionBackground
      selectionBackground = []
      return Effect.forEach(fibers, Fiber.interrupt, { discard: true })
    })
    const interruptSelectionLoad = Effect.suspend(() => {
      const fiber = selectionLoadFiber
      selectionLoadFiber = undefined
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
    })
    const projection = InteractiveSelection.makeInteractiveSelectionProjection({
      activitySequence,
      interactiveThread,
      setActiveSelectionState: (value: SelectionEpochState) => (activeSelectionState = value),
      setCurrentSelectionEpoch: (value: number) => (currentSelectionEpoch = value),
      setSelectedThreadId: (value: string) => (selectedThreadId = value),
    })
    const {
      openSelectionProjectionFeed,
      startSelectionProjectionFeed,
      closeCandidateProjectionFeed,
      activateCreatedThread,
    } = projection
    let lifecycle: "open" | "closed" = "open"
    let feedAttached = false
    const sessionClosed = OperationUnavailable.make({
      operation: "InteractiveSession",
      message: "Interactive session is closed",
    })
    const composition = makeInteractiveSessionComposition({
      admission: lifecycleAdmission,
      scope: sessionScope,
      closed: sessionClosed,
      isOpen: () => lifecycle === "open",
      isAttached: () => feedAttached,
      setAttached: (attached) => (feedAttached = attached),
    })
    return {
      operationFeed,
      selectionDispatch,
      emit,
      sessionDispatch,
      selectionRequest,
      interactiveThread,
      getSelectionLoad: () => selectionLoad,
      setSelectionLoad: (value: SelectionLoad | undefined) => (selectionLoad = value),
      getSelectionLoadFiber: () => selectionLoadFiber,
      setSelectionLoadFiber: (value: Fiber.Fiber<unknown, unknown> | undefined) => (selectionLoadFiber = value),
      getCurrentSelectionEpoch: () => currentSelectionEpoch,
      setCurrentSelectionEpoch: (value: number) => (currentSelectionEpoch = value),
      getSelectedThreadId: () => selectedThreadId,
      setSelectedThreadId: (value: string | undefined) => (selectedThreadId = value),
      getActiveSelectionState: () => activeSelectionState,
      setActiveSelectionState: (value: SelectionEpochState | undefined) => (activeSelectionState = value),
      getCandidateSelectionState: () => candidateSelectionState,
      setCandidateSelectionState: (value: SelectionEpochState | undefined) => (candidateSelectionState = value),
      selectionBackground,
      isCurrentSelectionState,
      finishSelection,
      interruptSelectionBackground,
      interruptSelectionLoad,
      openSelectionProjectionFeed,
      startSelectionProjectionFeed,
      closeCandidateProjectionFeed,
      activateCreatedThread,
      selectionAdmission,
      transcriptPageAdmission,
      submissionAdmission,
      lifecycleAdmission,
      sessionScope,
      composition,
      sessionClosed,
      dispatchFailure,
      getLifecycle: () => lifecycle,
      setLifecycle: (value: "open" | "closed") => (lifecycle = value),
    }
  })
