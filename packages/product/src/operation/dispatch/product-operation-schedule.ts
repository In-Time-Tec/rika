import { OperationError } from "../operation-error"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Duration, Effect, Deferred, Ref, Cause, Scope } from "effect"
import { settleAbandonedRecoveredWork } from "../../execution/lifecycle/abandoned-product-work-settlement"
import type { InteractiveEvent } from "../interactive/interactive-event"
import type { InteractiveSession } from "../contract/interactive-operation"
import { failureKind } from "../operation-error"

export const makeProductOperationSchedule = (input: any): any =>
  Effect.gen(function* () {
    const {
      options,
      ownerScope,
      makeInteractiveSession,
      watchedThreadIds,
      executionDependencies,
      reconcileExecutions,
      reconcileThreadResults,
      titleThread,
      publishInteractiveActivity,
      rootTurnOwner: _rootTurnOwner,
      hasActiveExecutionWork: _hasActiveExecutionWork,
      stopActiveExecutionWorkWithProjection: _stopActiveExecutionWorkWithProjection,
      replacementAdmission: _replacementAdmission,
      replacementState: _replacementState,
      activeWorkflows: _activeWorkflows,
      rawBackend: _rawBackend,
      repairThreadSummaries,
      pendingTurnCapacity: _pendingTurnCapacity,
      executionIngest: _executionIngest,
      acquiredBackend: _acquiredBackend,
      turnChanges: _turnChanges,
      dirtyTurnObservers: _dirtyTurnObservers,
      ensureIngest: _ensureIngest,
      notifyTurnChanged: _notifyTurnChanged,
      claimTurnObserver: _claimTurnObserver,
      isTerminalStatus: _isTerminalStatus,
    } = input
    const typedOwnerScope: Scope.Scope = ownerScope
    const typedExecutionDependencies: Context.Context<ThreadRepository.Service | TurnRepository.Service> =
      executionDependencies
    const typedWatchedThreadIds: () => ReadonlySet<string> = watchedThreadIds
    const typedMakeInteractiveSession: (
      workspace: string,
      settings: { readonly registerPromoter: boolean },
    ) => Effect.Effect<InteractiveMade, OperationError, never> = makeInteractiveSession
    const typedReconcileExecutions: Effect.Effect<void, OperationError, never> = reconcileExecutions
    const typedReconcileThreadResults: () => Effect.Effect<boolean, OperationError, never> = reconcileThreadResults
    const typedRepairThreadSummaries: () => Effect.Effect<void, OperationError, never> = repairThreadSummaries
    const typedTitleThread: (
      thread: import("@rika/product/thread-record").Thread,
      turn: Turn.AgentExecutionTurn,
      dispatch: (event: InteractiveEvent) => void,
    ) => Effect.Effect<void, OperationError, never> = titleThread
    type InteractiveMade = {
      readonly session: InteractiveSession
      readonly supervise: Effect.Effect<void, OperationError, never>
      readonly followClaimed?: (turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never>
      readonly close: Effect.Effect<void, never, never>
    }
    const owner = yield* typedMakeInteractiveSession(options.defaultWorkspace, {
      registerPromoter: true,
    })
    yield* Effect.forkIn(owner.supervise, typedOwnerScope)
    yield* Effect.forkIn(
      settleAbandonedRecoveredWork(
        Duration.fromInputUnsafe(options.recoveredWorkGrace ?? "15 seconds"),
        typedWatchedThreadIds,
      ).pipe(
        Effect.provide(typedExecutionDependencies),
        Effect.catch((failure) =>
          Effect.logError("execution.recovery.abandonment_failed").pipe(
            Effect.annotateLogs("rika.failure.kind", String(failure)),
          ),
        ),
      ),
      typedOwnerScope,
    )
    const repairSummariesOnce = yield* Effect.cached(
      typedRepairThreadSummaries().pipe(
        Effect.provide(typedExecutionDependencies),
        Effect.catch((error) =>
          Effect.logError("thread-summary.repair.failed").pipe(Effect.annotateLogs("rika.failure.kind", String(error))),
        ),
      ),
    )
    const repairThreadTitles = Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      for (const thread of yield* threads.listAll) {
        const firstTurn = (yield* turns.list(thread.id))[0]
        if (
          firstTurn !== undefined &&
          ThreadResult.TurnResult.isAgentExecution(firstTurn) &&
          firstTurn.status === "completed"
        )
          yield* typedTitleThread(thread, firstTurn, (event: InteractiveEvent) => publishInteractiveActivity(0, event))
      }
    }).pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.catchCause((cause) =>
        Effect.logError("thread-title.repair.failed").pipe(
          Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
        ),
      ),
    )
    type ReconcileSchedule =
      | { readonly running: false }
      | { readonly running: true; readonly rescan: boolean; readonly completed: Deferred.Deferred<void> }
    const reconcileSchedule = yield* Ref.make<ReconcileSchedule>({ running: false })
    let requestResultRetry: Effect.Effect<void> = Effect.void
    const runScheduledReconcile = Effect.fn("ProductOperation.runScheduledReconcile")(function* (
      completed: Deferred.Deferred<void>,
    ) {
      while (true) {
        yield* typedReconcileExecutions.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("execution.repair.failed").pipe(
                  Effect.annotateLogs({
                    "rika.failure.kind": failureKind(cause),
                    "rika.failure.message": String(Cause.squash(cause)),
                  }),
                ),
          ),
        )
        const retryResults = yield* typedReconcileThreadResults().pipe(
          Effect.provide(typedExecutionDependencies),
          Effect.catchCause((cause) =>
            Effect.logError("thread-result.repair.failed").pipe(
              Effect.annotateLogs("rika.failure.message", String(Cause.squash(cause))),
              Effect.as(false),
            ),
          ),
        )
        yield* repairThreadTitles
        const repeat = yield* Ref.modify(reconcileSchedule, (state) => {
          if (!state.running) return [false, state] as const
          return state.rescan
            ? [true, { running: true, rescan: false, completed: state.completed } as const]
            : [false, { running: false } as const]
        })
        if (!repeat) {
          if (retryResults === true) yield* requestResultRetry
          yield* Deferred.succeed(completed, undefined)
          return
        }
      }
    })
    const scheduleReconcile = Effect.gen(function* () {
      const candidate = yield* Deferred.make<void>()
      const scheduled = yield* Ref.modify(reconcileSchedule, (state) =>
        state.running
          ? [
              { launch: false, completed: state.completed },
              { running: true, rescan: true, completed: state.completed },
            ]
          : [
              { launch: true, completed: candidate },
              { running: true, rescan: false, completed: candidate },
            ],
      )
      if (scheduled.launch) yield* Effect.forkIn(runScheduledReconcile(scheduled.completed), typedOwnerScope)
      return scheduled.completed
    })
    requestResultRetry = Effect.forkIn(
      Effect.sleep("1 second").pipe(Effect.andThen(scheduleReconcile), Effect.asVoid),
      typedOwnerScope,
    ).pipe(Effect.asVoid)
    return { owner, repairSummariesOnce, repairThreadTitles, reconcileSchedule, scheduleReconcile }
  })
