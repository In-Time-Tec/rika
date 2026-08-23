import * as ExecutionRequest from "@rika/product/execution-request"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { Effect, Function, Context, Schema, Semaphore, Exit, Scope, Deferred } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"
import { OperationUnavailable } from "../contract/product-operation"
import { type InteractiveEvent } from "./session-event"
import { makeInteractiveQueue } from "./turn/queue"
import { makeInteractiveSubmission } from "./turn/admission"
import { makeInteractiveFollowing, makeInteractiveSupervision, ignoreInteractiveEvent } from "./turn/observation"
import { makeInteractiveTranscript } from "./view/transcript-window"
import { makeInteractiveControl, makeInteractiveSessionControls } from "./turn/control"
import { type InteractiveSessionState, makeInteractiveSessionState } from "./session-state"
import { makeInteractiveShell } from "./shell"
import { type InteractiveOperationFeed } from "./view/feed"
import { makeInteractiveSessionSelection, type SelectionEpochState } from "./view/selection"
import type {
  InteractiveRuntimeContext,
  InteractiveSession,
  InteractiveSessionInput,
  InteractiveSessionRuntimeResult,
  InteractiveSupervisionError,
} from "./session-contract"

export type {
  InteractiveDependencyContext,
  InteractiveExecutionContext,
  InteractiveExecutionContextServices,
  InteractiveRuntimeContext,
  InteractiveSession,
  InteractiveSessionInput,
  InteractiveSessionRuntimeResult,
  PreparedTurn,
} from "./session-contract"
export const makeInteractiveExecution = (input: InteractiveRuntimeContext) => {
  const queue = makeInteractiveQueue(input)
  const submit = makeInteractiveSubmission({ ...input, ...queue })
  const safe = <A, E, R>(dispatch: (event: InteractiveEvent) => void, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(input.executionDependencies),
      Effect.scoped,
      Effect.catch((error) => Effect.sync(() => input.dispatchFailure(dispatch, error))),
    )
  return { submit, safe, ...queue }
}
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
const makeInteractiveFollowingComponentsImpl = (
  input: InteractiveSessionInput,
  execution: ReturnType<typeof makeInteractiveExecution>,
) =>
  makeInteractiveFollowing({
    rootTurnOwner: input.rootTurnOwner,
    setTurnStatus: input.setTurnStatus,
    settleThread: execution.settleThread,
    threadForTurn: execution.threadForTurn,
    claimTurnObserver: input.claimTurnObserver,
    releaseTurnObserver: input.releaseTurnObserver,
  })
export const makeInteractiveFollowingComponents: {
  (
    arg1: ReturnType<typeof makeInteractiveExecution>,
  ): (arg0: InteractiveSessionInput) => ReturnType<typeof makeInteractiveFollowingComponentsImpl>
  (
    arg0: InteractiveSessionInput,
    arg1: ReturnType<typeof makeInteractiveExecution>,
  ): ReturnType<typeof makeInteractiveFollowingComponentsImpl>
} = Function.dual(2, makeInteractiveFollowingComponentsImpl)
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
const makeInteractiveSupervisionComponentsImpl = (
  input: InteractiveRuntimeContext,
  state: InteractiveSessionState,
  following: ReturnType<typeof makeInteractiveFollowing>,
  execution: ReturnType<typeof makeInteractiveExecution>,
) => {
  const supervise = makeInteractiveSupervision({
    acquiredBackend: input.acquiredBackend,
    rootTurnOwner: input.rootTurnOwner,
    executionDependencies: input.executionDependencies,
    turnChanges: input.turnChanges,
    dirtyTurnObservers: input.dirtyTurnObservers,
    isTerminalStatus: input.isTerminalStatus,
    setTurnStatus: input.setTurnStatus,
    settleThread: execution.settleThread,
    notifyTurnChanged: input.notifyTurnChanged,
    claimTurnObserver: input.claimTurnObserver,
    observeTurn: following.observeTurn,
    recoveryOwner: input.recoveryOwner,
    sessionThreadViews: input.sessionThreadViews,
    sessionId: input.sessionId,
    getSelectedThreadId: state.getSelectedThreadId,
    interactiveSinks: input.interactiveSinks,
    operationFeed: state.operationFeed,
    queueMutationEvent: input.queueMutationEvent,
    initialized: input.supervisionInitialized,
  })
  const control = makeInteractiveControl({
    turns: Context.get(input.dependencyContext, TurnRepository.Service),
    transcripts: Context.get(input.dependencyContext, TranscriptRepository.Service),
    backend: input.acquiredBackend,
    rootTurnOwner: input.rootTurnOwner,
    active: execution.active,
    dispatch: state.sessionDispatch,
    queueMutation: input.queueMutationEvent,
    notifyTurnChanged: input.notifyTurnChanged,
    fail: input.operationError,
  })
  return { supervise, control }
}
export const makeInteractiveSupervisionComponents: {
  (
    arg1: InteractiveSessionState,
    arg2: ReturnType<typeof makeInteractiveFollowing>,
    arg3: ReturnType<typeof makeInteractiveExecution>,
  ): (arg0: InteractiveRuntimeContext) => ReturnType<typeof makeInteractiveSupervisionComponentsImpl>
  (
    arg0: InteractiveRuntimeContext,
    arg1: InteractiveSessionState,
    arg2: ReturnType<typeof makeInteractiveFollowing>,
    arg3: ReturnType<typeof makeInteractiveExecution>,
  ): ReturnType<typeof makeInteractiveSupervisionComponentsImpl>
} = Function.dual(4, makeInteractiveSupervisionComponentsImpl)
export const makeInteractiveSessionEvents = (
  input: InteractiveImplementationInput,
): Pick<
  InteractiveSession,
  | "events"
  | "submit"
  | "newThread"
  | "archiveThread"
  | "archiveAndNewThread"
  | "shell"
  | "editQueued"
  | "dequeue"
  | "steerQueued"
  | "approveAuthorization"
  | "denyAuthorization"
> => {
  const operationFeed: InteractiveOperationFeed = input.operationFeed
  const submissionAdmission: Semaphore.Semaphore = input.submissionAdmission
  const operationUnavailable = (operation: string) => (error: unknown) =>
    Schema.is(OperationUnavailable)(error) ? error : OperationUnavailable.make({ operation, message: String(error) })
  const events = (dispatch: Parameters<InteractiveSession["events"]>[0]) =>
    Effect.gen(function* () {
      yield* input.dispatchThreadSummaries(input.sessionDispatch)
      yield* operationFeed.events(dispatch, input.getCurrentSelectionEpoch, input.getSelectedThreadId)
    }).pipe(
      Effect.provide(input.executionDependencies),
      Effect.mapError((error) =>
        Schema.is(OperationUnavailable)(error)
          ? error
          : OperationUnavailable.make({ operation: "InteractiveSession.events", message: String(error) }),
      ),
    )
  const submit = (
    prompt: string,
    mode?: ModeId,
    parts?: ReadonlyArray<ExecutionRequest.PromptPart>,
    tuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) =>
    input.submit(prompt, input.sessionDispatch, mode, parts, tuning, submissionId) as Effect.Effect<
      void,
      OperationUnavailable,
      never
    >
  const shell = makeInteractiveShell(input)
  return {
    events,
    submit: (prompt, mode, parts, tuning, submissionId) => submit(prompt, mode, parts, tuning, submissionId),
    newThread: input.safe(
      input.sessionDispatch,
      submissionAdmission.withPermits(1)(Effect.uninterruptible(input.createAndSelectThread())),
    ),
    archiveThread: input
      .archiveCurrentThread()
      .pipe(
        Effect.provide(input.executionDependencies),
        Effect.mapError(operationUnavailable("InteractiveSession.archiveThread")),
      ),
    archiveAndNewThread: submissionAdmission
      .withPermits(1)(Effect.uninterruptible(input.archiveAndCreateThread()))
      .pipe(
        Effect.provide(input.executionDependencies),
        Effect.mapError(operationUnavailable("InteractiveSession.archiveAndNewThread")),
      ),
    shell: (threadId, command, incognito) => shell(threadId, command, incognito),
    editQueued: (id, prompt) => input.safe(input.sessionDispatch, input.control.editQueued(id, prompt)),
    dequeue: (id) => input.safe(input.sessionDispatch, input.control.dequeue(id)),
    steerQueued: (id, text, requestId) =>
      input.safe(input.sessionDispatch, input.control.steerQueued(id, text, requestId)),
    approveAuthorization: (turnId, authorizationId, checkpoint) =>
      input.safe(input.sessionDispatch, input.control.approveAuthorization(turnId, authorizationId, checkpoint)),
    denyAuthorization: (turnId, authorizationId, checkpoint) =>
      input.safe(input.sessionDispatch, input.control.denyAuthorization(turnId, authorizationId, checkpoint)),
  }
}
export type InteractiveImplementationInput = InteractiveRuntimeContext &
  ReturnType<typeof makeInteractiveExecution> &
  ReturnType<typeof makeInteractiveFollowing> &
  ReturnType<typeof makeInteractiveTranscript> &
  ReturnType<typeof makeInteractiveSupervisionComponents> & {
    readonly getCurrentSelectionEpoch: () => number
    readonly getSelectedThreadId: () => string | undefined
    readonly getActiveSelectionState: () => SelectionEpochState | undefined
    readonly selectionMatches: (candidate: SelectionEpochState | undefined, threadId: string, epoch: number) => boolean
  }
export type InteractiveSessionControlsInput = Omit<InteractiveImplementationInput, "submit">
export type InteractiveSessionSelectionInput = Omit<InteractiveImplementationInput, "submit">
export const makeInteractiveImplementation = (input: InteractiveImplementationInput): InteractiveSession => {
  const events = makeInteractiveSessionEvents(input)
  const controls = makeInteractiveSessionControls({ ...input, ...events })
  const selection = makeInteractiveSessionSelection({ ...input, ...events, ...controls })
  return { ...events, ...controls, ...selection }
}
type TurnId = import("@rika/product/turn-record").TurnId
type OperationError = import("../operation-error").OperationError
export const makeInteractiveSession = (
  input: InteractiveSessionInput,
): ((
  workspace: string,
  settings?: { readonly initialThreadId?: string; readonly recoveryOwner?: boolean },
) => Effect.Effect<InteractiveSessionRuntimeResult, OperationError, never>) =>
  Effect.fn("ProductOperation.makeInteractiveSession")(function* (
    workspace: string,
    settings: { readonly initialThreadId?: string; readonly recoveryOwner?: boolean } = {},
  ) {
    const sessionId = input.nextSessionId()
    const supervisionInitialized = yield* Deferred.make<void, InteractiveSupervisionError>()
    const state: InteractiveSessionState = yield* makeInteractiveSessionState({
      sessionId,
      publishInteractiveActivity: input.publishInteractiveActivity,
      activitySequence: input.activitySequence,
      options: input.options,
      initialThreadId: settings.initialThreadId,
      recoveryOwner: settings.recoveryOwner ?? false,
    })
    const typedLifecycleAdmission: Semaphore.Semaphore = state.lifecycleAdmission
    const typedGetLifecycle: () => "open" | "closed" = state.getLifecycle
    const typedSetLifecycle: (value: "open" | "closed") => void = state.setLifecycle
    const typedInteractiveSinks: Map<number, unknown> = input.interactiveSinks
    const typedSessionThreadViews: Map<number, unknown> = input.sessionThreadViews
    const typedOperationFeed: InteractiveOperationFeed = state.operationFeed
    const typedSessionScope: Scope.Scope = state.sessionScope
    const runtimeInput = {
      ...input,
      ...state,
      workspace,
      sessionId,
      recoveryOwner: settings.recoveryOwner ?? false,
      supervisionInitialized,
      emit: state.emit,
      dispatchFailure: state.dispatchFailure,
      admit: state.composition.admit,
      admitLocal: state.composition.admitLocal,
      attachFeed: state.composition.attachFeed,
    }
    const execution = makeInteractiveExecutionComponents(runtimeInput, state)
    const following = makeInteractiveFollowingComponents(runtimeInput, execution)
    const transcript = makeInteractiveTranscriptComponents(runtimeInput, state)
    const supervision = makeInteractiveSupervisionComponents(runtimeInput, state, following, execution)
    const implementation = makeInteractiveImplementation({
      ...runtimeInput,
      ...execution,
      ...following,
      ...transcript,
      ...supervision,
      getCurrentSelectionEpoch: state.getCurrentSelectionEpoch,
      getSelectedThreadId: state.getSelectedThreadId,
      getActiveSelectionState: state.getActiveSelectionState,
      selectionMatches: (candidate: SelectionEpochState | undefined, threadId: string, epoch: number) =>
        candidate !== undefined && String(candidate.thread.id) === threadId && candidate.epoch === epoch,
    })
    const session: InteractiveSession = {
      events: (dispatch) => state.composition.attachFeed(implementation.events(dispatch)),
      submit: (prompt, mode, parts, tuning, submissionId) =>
        state.composition.admit(implementation.submit(prompt, mode, parts, tuning, submissionId)),
      newThread: state.composition.admitLocal(implementation.newThread),
      archiveThread: state.composition.admitLocal(implementation.archiveThread),
      archiveAndNewThread: state.composition.admitLocal(implementation.archiveAndNewThread),
      shell: (threadId, command, incognito) =>
        state.composition.admitLocal(implementation.shell(threadId, command, incognito)),
      editQueued: (turnId, prompt) => state.composition.admitLocal(implementation.editQueued(turnId, prompt)),
      dequeue: (turnId) => state.composition.admitLocal(implementation.dequeue(turnId)),
      steerQueued: (turnId, text, requestId) =>
        state.composition.admitLocal(implementation.steerQueued(turnId, text, requestId)),
      steer: (text, requestId, targetTurnId) =>
        state.composition.admitLocal(implementation.steer(text, requestId, targetTurnId)),
      approveAuthorization: (turnId, authorizationId, checkpoint) =>
        state.composition.admitLocal(implementation.approveAuthorization(turnId, authorizationId, checkpoint)),
      denyAuthorization: (turnId, authorizationId, checkpoint) =>
        state.composition.admitLocal(implementation.denyAuthorization(turnId, authorizationId, checkpoint)),
      interruptAndSend: (prompt) => state.composition.admitLocal(implementation.interruptAndSend(prompt)),
      cancel: state.composition.admitLocal(implementation.cancel),
      quit: implementation.quit,
      selectThread: (threadId) => state.composition.admitLocal(implementation.selectThread(threadId)),
      readQueue: (threadId) => state.composition.admitLocal(implementation.readQueue(threadId)),
      previewThread: (threadId, requestId) =>
        state.composition.admitLocal(implementation.previewThread(threadId, requestId)),
      reopenThread: state.composition.admitLocal(implementation.reopenThread),
    }
    return {
      session,
      supervise: supervision.supervise,
      initialized: Deferred.await(supervisionInitialized),
      watchClaimed: (turnId: TurnId) => following.watchClaimedTurn(turnId, ignoreInteractiveEvent),
      close: typedLifecycleAdmission.withPermits(1)(
        Effect.suspend(() => {
          if (typedGetLifecycle() === "closed") return Effect.void
          typedSetLifecycle("closed")
          typedInteractiveSinks.delete(sessionId)
          typedSessionThreadViews.delete(sessionId)
          return typedOperationFeed.close.pipe(Effect.andThen(Scope.close(typedSessionScope, Exit.void)))
        }),
      ),
    }
  })
