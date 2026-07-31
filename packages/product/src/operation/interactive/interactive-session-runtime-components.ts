import * as TurnRepository from "@rika/product/turn-repository"
import { Context } from "effect"
import { makeInteractiveExecution } from "./interactive-session-execution"
import { makeInteractiveFollowing } from "./interactive-session-following"
import { makeInteractiveTranscript } from "./interactive-session-transcript-runtime"
import { makeInteractiveSupervision } from "./interactive-session-supervision"
import { makeInteractiveControl } from "./interactive-control"

export const makeInteractiveExecutionComponents = (input: any, state: any) => {
  const execution = makeInteractiveExecution({
    ...input,
    ...state,
    interactiveThread: state.interactiveThread,
    selectionRequest: state.selectionRequest,
    getSelectionLoad: state.getSelectionLoad,
    setSelectionLoad: state.setSelectionLoad,
    getSelectionLoadFiber: state.getSelectionLoadFiber,
    setSelectionLoadFiber: state.setSelectionLoadFiber,
    getCurrentSelectionEpoch: state.getCurrentSelectionEpoch,
    setCurrentSelectionEpoch: state.setCurrentSelectionEpoch,
    getSelectedThreadId: state.getSelectedThreadId,
    setSelectedThreadId: state.setSelectedThreadId,
    getActiveSelectionState: state.getActiveSelectionState,
    setActiveSelectionState: state.setActiveSelectionState,
    getCandidateSelectionState: state.getCandidateSelectionState,
    setCandidateSelectionState: state.setCandidateSelectionState,
    selectionBackground: state.selectionBackground,
    isCurrentSelectionState: state.isCurrentSelectionState,
    finishSelection: state.finishSelection,
    interruptSelectionBackground: state.interruptSelectionBackground,
    interruptSelectionLoad: state.interruptSelectionLoad,
    openSelectionProjectionFeed: state.openSelectionProjectionFeed,
    startSelectionProjectionFeed: state.startSelectionProjectionFeed,
    closeCandidateProjectionFeed: state.closeCandidateProjectionFeed,
    activateCreatedThread: state.activateCreatedThread,
    selectionAdmission: state.selectionAdmission,
    transcriptPageAdmission: state.transcriptPageAdmission,
    submissionAdmission: state.submissionAdmission,
    lifecycleAdmission: state.lifecycleAdmission,
    sessionScope: state.sessionScope,
    composition: state.composition,
    sessionClosed: state.sessionClosed,
    dispatchFailure: state.dispatchFailure,
    awaitSessionQuiescence: input.awaitSessionQuiescence,
  })
  return execution
}

export const makeInteractiveFollowingComponents = (input: any, execution: any) =>
  makeInteractiveFollowing({
    rootTurnOwner: input.rootTurnOwner,
    ensureIngest: input.ensureIngest,
    deliverResultEvents: input.deliverResultEvents,
    setTurnStatus: input.setTurnStatus,
    projectExecutionResult: input.projectExecutionResult,
    settleThread: execution.settleThread,
    threadForTurn: execution.threadForTurn,
    titleThread: input.titleThread,
    claimTurnObserver: input.claimTurnObserver,
    releaseTurnObserver: input.releaseTurnObserver,
    emit: input.emit,
  })

export const makeInteractiveTranscriptComponents = (input: any, state: any) =>
  makeInteractiveTranscript({
    ...input,
    ...state,
    executionDependencies: input.executionDependencies,
    dependencyContext: input.dependencyContext,
    sessionDispatch: state.sessionDispatch,
    selectionDispatch: state.selectionDispatch,
    operationFeed: state.operationFeed,
    dispatchFailure: state.dispatchFailure,
  })

export const makeInteractiveSupervisionComponents = (input: any, state: any, following: any, execution: any) => {
  const supervise = makeInteractiveSupervision({
    acquiredBackend: input.acquiredBackend,
    executionDependencies: input.executionDependencies,
    turnChanges: input.turnChanges,
    dirtyTurnObservers: input.dirtyTurnObservers,
    ensureIngest: input.ensureIngest,
    setTurnStatus: input.setTurnStatus,
    isTerminalStatus: input.isTerminalStatus,
    executionIngest: input.executionIngest,
    notifyTurnChanged: input.notifyTurnChanged,
    claimTurnObserver: input.claimTurnObserver,
    observeTurn: following.observeTurn,
    registerPromoter: input.registerPromoter,
    sessionThreadViews: input.sessionThreadViews,
    sessionId: input.sessionId,
    getSelectedThreadId: state.getSelectedThreadId,
    interactiveSinks: input.interactiveSinks,
    operationFeed: state.operationFeed,
  })
  let steeringIdentitySequence = 0
  const nextSteeringIdentity = (turnId: string) => `rika:interactive-steer:${turnId}:${steeringIdentitySequence++}`
  const control = makeInteractiveControl({
    turns: Context.get(input.dependencyContext, TurnRepository.Service),
    backend: input.acquiredBackend,
    pendingCapacity: input.pendingTurnCapacity,
    active: execution.active,
    dispatch: state.sessionDispatch,
    queueMutation: input.queueMutationEvent,
    nextSteeringIdentity,
    fail: input.operationError,
  })
  return { supervise, nextSteeringIdentity, control }
}
