import * as Thread from "@rika/product/thread-record"
import { Effect, Fiber, Ref, Scope, Semaphore } from "effect"
import { OperationUnavailable } from "../contract/product-operation-service"
import { makeInteractiveOperationFeed } from "./interactive-operation-feed"
import { makeInteractiveSessionComposition } from "./interactive-session-composition"
import { makeInteractiveSelectionProjection } from "./interactive-selection-projection"
import { dispatchInteractiveFailure } from "./interactive-session-errors"
import type { SelectionEpochState } from "../dispatch/execution-operation-coordination"

export const makeInteractiveSessionState = (input: any): any =>
  Effect.gen(function* () {
    const { sessionId, executionIngest, publishInteractiveActivity, activitySequence, initialThreadId } = input
    let selectedThreadId = initialThreadId
    let currentSelectionEpoch = 0
    let selectionLoad: import("./interactive-operation-feed").SelectionLoad | undefined =
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
    const operationFeed = yield* makeInteractiveOperationFeed({
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
    const projection = makeInteractiveSelectionProjection({
      executionIngest,
      sessionScope,
      selectionBackground,
      operationFeed,
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
      setSelectionLoad: (value: any) => (selectionLoad = value),
      getSelectionLoadFiber: () => selectionLoadFiber,
      setSelectionLoadFiber: (value: any) => (selectionLoadFiber = value),
      getCurrentSelectionEpoch: () => currentSelectionEpoch,
      setCurrentSelectionEpoch: (value: number) => (currentSelectionEpoch = value),
      getSelectedThreadId: () => selectedThreadId,
      setSelectedThreadId: (value: string | undefined) => (selectedThreadId = value),
      getActiveSelectionState: () => activeSelectionState,
      setActiveSelectionState: (value: any) => (activeSelectionState = value),
      getCandidateSelectionState: () => candidateSelectionState,
      setCandidateSelectionState: (value: any) => (candidateSelectionState = value),
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
