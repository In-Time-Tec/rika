import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import type { TurnPromoter } from "../../execution/contract/execution-identifier"
import { Effect, Exit, Scope, Semaphore } from "effect"
import type { InteractiveSession } from "./interactive-session"
import type { ProductLayerOptions } from "../dispatch/product-operation-options"
import { makeInteractiveSessionState, type InteractiveSessionState } from "./interactive-session-state"
import { makeInteractiveImplementation } from "./interactive-session-interface"
import {
  makeInteractiveExecutionComponents,
  makeInteractiveFollowingComponents,
  makeInteractiveTranscriptComponents,
  makeInteractiveSupervisionComponents,
} from "./interactive-session-runtime-components"
import { ignoreInteractiveEvent } from "./interactive-session-following"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import { OperationError } from "../operation-error"

export interface InteractiveSessionInput {
  readonly options: ProductLayerOptions<any, any, any, any, any, any, any>
  readonly executionIngest: any
  readonly pendingTurnCapacity: number
  readonly rootTurnOwner: any
  readonly turnMutationAdmission: any
  readonly resolveExecutionRoute: any
  readonly notifyThreadSummaries: any
  readonly ensureIngest: any
  readonly prepareExecution: any
  readonly setTurnStatus: any
  readonly projectExecutionResult: any
  readonly deliverResultEvents: any
  readonly executionDependencies: any
  readonly claimTurnObserver: any
  readonly releaseTurnObserver: any
  readonly acquiredBackend: any
  readonly turnChanges: any
  readonly dirtyTurnObservers: Set<any>
  readonly usageRepository: any
  readonly createForSubmission: any
  readonly stopActiveExecutionWorkWithProjection: any
  readonly publishInteractiveActivity: any
  readonly temporaryThreadTitle: any
  readonly ensureTurnSummary: any
  readonly queueMutationEvent: any
  readonly titleThread: any
  readonly notifyTurnChanged: any
  readonly claimQueuedTurn: any
  readonly dependencyContext: any
  readonly sessionThreadViews: any
  readonly interactiveSinks: any
  readonly selectionInitialTurnWindow: number
  readonly selectionInitialEntryWindow: number
  readonly encodeJson: any
  readonly isTerminalStatus: any
  readonly executionStartFailureMessage: string
  readonly dispatchThreadSummaries: any
  readonly recordedShellStartedEvent: any
  readonly recordedShellSettledEvents: any
  readonly executeShellCommand: typeof import("./interactive-operation-leaves").executeShellCommand
  readonly nextSessionId: () => number
  readonly activitySequence: number
}

export interface InteractiveSessionRuntimeResult {
  readonly session: InteractiveSession
  readonly supervise: Effect.Effect<void, OperationError, never>
  readonly followClaimed: ((turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never>) | undefined
  readonly close: Effect.Effect<void, never, never>
}

export const makeInteractiveSession = (
  input: InteractiveSessionInput,
): ((
  workspace: string,
  settings?: { readonly initialThreadId?: string; readonly registerPromoter?: boolean },
) => Effect.Effect<InteractiveSessionRuntimeResult, OperationError, never>) =>
  Effect.fn("ProductOperation.makeInteractiveSession")(function* (
    workspace: string,
    settings: { readonly initialThreadId?: string; readonly registerPromoter?: boolean } = {},
  ) {
    const sessionId = input.nextSessionId()
    const state: InteractiveSessionState = yield* makeInteractiveSessionState({
      sessionId,
      executionIngest: input.executionIngest,
      publishInteractiveActivity: input.publishInteractiveActivity,
      activitySequence: input.activitySequence,
      options: input.options,
      initialThreadId: settings.initialThreadId,
      registerPromoter: settings.registerPromoter ?? false,
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
      selectionMatches: (candidate: any, threadId: string, epoch: number) =>
        candidate !== undefined && String(candidate.thread.id) === threadId && candidate.epoch === epoch,
    })
    const session: InteractiveSession = {
      events: (dispatch) => state.composition.attachFeed(implementation.events(dispatch)),
      submit: (prompt, mode, parts, tuning, submissionId) =>
        state.composition.admit(implementation.submit(prompt, mode, parts, tuning, submissionId)),
      newThread: state.composition.admitLocal(implementation.newThread),
      shell: (threadId, command, incognito) =>
        state.composition.admitLocal(implementation.shell(threadId, command, incognito)),
      editQueued: (turnId, prompt) => state.composition.admitLocal(implementation.editQueued(turnId, prompt)),
      dequeue: (turnId) => state.composition.admitLocal(implementation.dequeue(turnId)),
      steerQueued: (turnId, text) => state.composition.admitLocal(implementation.steerQueued(turnId, text)),
      steer: (text, targetTurnId) => state.composition.admitLocal(implementation.steer(text, targetTurnId)),
      interruptAndSend: (prompt) => state.composition.admitLocal(implementation.interruptAndSend(prompt)),
      cancel: state.composition.admitLocal(implementation.cancel),
      quit: implementation.quit,
      selectThread: (threadId, epoch) => state.composition.admitLocal(implementation.selectThread(threadId, epoch)),
      readQueue: (threadId) => state.composition.admitLocal(implementation.readQueue(threadId)),
      loadOlder: (threadId, epoch, before, loadedKeys) =>
        state.composition.admitLocal(implementation.loadOlder(threadId, epoch, before, loadedKeys)),
      loadNewer: (threadId, epoch, after) =>
        state.composition.admitLocal(implementation.loadNewer(threadId, epoch, after)),
      previewThread: (threadId) => state.composition.admitLocal(implementation.previewThread(threadId)),
      reopenThread: (epoch) => state.composition.admitLocal(implementation.reopenThread(epoch)),
    }
    const typedAcquiredBackend: ExecutionBackend.Interface = input.acquiredBackend
    const typedRegisterTurnPromoter: ((promoter: TurnPromoter) => Effect.Effect<void, never, never>) | undefined =
      typedAcquiredBackend.registerTurnPromoter
    if ((settings.registerPromoter ?? false) && typedRegisterTurnPromoter !== undefined)
      yield* typedRegisterTurnPromoter(execution.promoterFor(() => undefined))
    return {
      session,
      supervise: supervision.supervise,
      followClaimed:
        input.acquiredBackend.follow === undefined
          ? undefined
          : (turnId: Turn.TurnId) => following.followClaimedTurn(turnId, ignoreInteractiveEvent),
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
