import { Context, Function } from "effect"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { makeInteractiveExecution } from "./interactive-session-execution"
import { makeInteractiveTranscript } from "./interactive-session-transcript-runtime"
import { makeInteractiveControl } from "./interactive-control"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"
import type { InteractiveSessionState } from "./interactive-session-state"

const makeInteractiveExecutionComponentsImpl = (input: InteractiveRuntimeContext, state: InteractiveSessionState) => {
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
  })
  return execution
}

export const makeInteractiveExecutionComponents: {
  (
    arg1: InteractiveSessionState,
  ): (arg0: InteractiveRuntimeContext) => ReturnType<typeof makeInteractiveExecutionComponentsImpl>
  (
    arg0: InteractiveRuntimeContext,
    arg1: InteractiveSessionState,
  ): ReturnType<typeof makeInteractiveExecutionComponentsImpl>
} = Function.dual(2, makeInteractiveExecutionComponentsImpl)

const makeInteractiveTranscriptComponentsImpl = (input: InteractiveRuntimeContext, state: InteractiveSessionState) =>
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

export const makeInteractiveTranscriptComponents: {
  (
    arg1: InteractiveSessionState,
  ): (arg0: InteractiveRuntimeContext) => ReturnType<typeof makeInteractiveTranscriptComponentsImpl>
  (
    arg0: InteractiveRuntimeContext,
    arg1: InteractiveSessionState,
  ): ReturnType<typeof makeInteractiveTranscriptComponentsImpl>
} = Function.dual(2, makeInteractiveTranscriptComponentsImpl)

const makeInteractiveControlComponentsImpl = (
  input: InteractiveRuntimeContext,
  execution: ReturnType<typeof makeInteractiveExecution>,
) => {
  let steeringIdentitySequence = 0
  const nextSteeringIdentity = (turnId: string) => `rika:interactive-steer:${turnId}:${steeringIdentitySequence++}`
  const control = makeInteractiveControl({
    turns: Context.get(input.dependencyContext, TurnRepository.Service),
    transcripts: Context.get(input.dependencyContext, TranscriptRepository.Service),
    backend: input.acquiredBackend,
    pendingCapacity: input.pendingTurnCapacity,
    active: execution.active,
    dispatch: input.sessionDispatch,
    queueMutation: input.queueMutationEvent,
    nextSteeringIdentity,
    notifyTurnChanged: input.notifyTurnChanged,
    fail: input.operationError,
  })
  return { control, nextSteeringIdentity }
}

export const makeInteractiveControlComponents: {
  (
    arg1: ReturnType<typeof makeInteractiveExecution>,
  ): (arg0: InteractiveRuntimeContext) => ReturnType<typeof makeInteractiveControlComponentsImpl>
  (
    arg0: InteractiveRuntimeContext,
    arg1: ReturnType<typeof makeInteractiveExecution>,
  ): ReturnType<typeof makeInteractiveControlComponentsImpl>
} = Function.dual(2, makeInteractiveControlComponentsImpl)
