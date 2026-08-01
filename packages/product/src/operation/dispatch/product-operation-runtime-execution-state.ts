import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnRepositoryContract from "../../thread/repository/turn-repository-contract"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionChildRun from "@rika/product/execution-child-run"
import { Effect, Fiber, PubSub, Scope, Semaphore } from "effect"
import { makeProductOperationFoundation } from "./product-operation-foundation"
import { operationError } from "../operation-error"
import { makeProductOperationExecution } from "./product-operation-execution"
import {
  executionStartFailureMessage,
  ingestFailureMessage,
  temporaryThreadTitle,
} from "../interactive/interactive-operation-leaves"

const watchedThreadIds = (sessionThreadViews: Map<number, () => string | undefined>) =>
  new Set(
    [...sessionThreadViews.values()].flatMap((view) => {
      const id = view()
      return id === undefined ? [] : [id]
    }),
  )

export const buildProductOperationExecutionState = (
  input: any,
): Effect.Effect<Readonly<Record<string, unknown>>, Error, never> =>
  Effect.gen(function* (): Effect.gen.Return<Readonly<Record<string, unknown>>, Error, never> {
    const { options, ownerScope: rawOwnerScope, publishInteractiveActivity, sessionThreadViews } = input
    const ownerScope: Scope.Scope = rawOwnerScope
    const pendingTurnCapacity = Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64))
    const reviewSettlementAdmission = yield* Semaphore.make(1)
    const reviewSettlements = new Map<string, Fiber.Fiber<ExecutionChildRun.FanOutInspection, any>>()
    const turnMutationAdmission = yield* Semaphore.make(1)
    const createForSubmission = (turns: TurnRepository.Interface, submission: TurnRepositoryContract.CreateInput) =>
      turnMutationAdmission.withPermits(1)(
        turns.createForSubmission(submission).pipe(Effect.mapError((error) => operationError(String(error), error))),
      )
    const turnChanges = yield* PubSub.sliding<void>(1)
    const dirtyTurnObservers = new Set<Turn.TurnId>()
    const watched = () => watchedThreadIds(sessionThreadViews)
    const foundation = yield* makeProductOperationFoundation({ options, ownerScope, publishInteractiveActivity }).pipe(
      Effect.provideService(Scope.Scope, ownerScope),
      Effect.mapError((error) => operationError(String(error), error)),
    )
    const {
      rootTurnOwner,
      titleExecutionId,
      extensionService,
      acquiredDependencies,
      withExecutionAdmission,
      commitUsageSource,
      publishThreadUsage,
      replacementAdmission,
      replacementState,
      activeWorkflows,
      rawBackend,
      acquiredBackend,
      backendLayer,
      dependencyContext,
      executionDependencies,
      usageRepository,
      executionIngest,
      ensureIngest,
      awaitIngestSettled,
      flushIngest,
      deliverResultEvents,
    } = foundation
    const claimTurnObserver = (turnId: Turn.TurnId, expectedStatus?: ExecutionStatus.Status) =>
      rootTurnOwner.claim(turnId, expectedStatus)
    const releaseTurnObserver = (turnId: Turn.TurnId, notify = true) =>
      Effect.uninterruptible(
        rootTurnOwner
          .release(turnId)
          .pipe(
            Effect.tap(() =>
              notify
                ? Effect.sync(() => dirtyTurnObservers.add(turnId)).pipe(
                    Effect.andThen(PubSub.publish(turnChanges, undefined)),
                  )
                : Effect.void,
            ),
          ),
      )
    const createObservedSubmission = (
      turns: TurnRepository.Interface,
      submission: TurnRepositoryContract.CreateInput,
    ) =>
      Effect.gen(function* () {
        const turn = yield* turns.createForSubmission(submission)
        return turn.status === "queued"
          ? { turn, claimed: false }
          : { turn, claimed: yield* rootTurnOwner.claim(turn.id, turn.status) }
      }).pipe(turnMutationAdmission.withPermits(1))
    const claimQueuedTurn = (threadId: Thread.ThreadId, now: number) => rootTurnOwner.claimQueued(threadId, now)
    const execution = yield* makeProductOperationExecution({
      options,
      ownerScope,
      pendingTurnCapacity,
      reviewSettlementAdmission,
      reviewSettlements,
      turnMutationAdmission,
      turnChanges,
      dirtyTurnObservers,
      rootTurnOwner,
      titleExecutionId,
      acquiredBackend,
      rawBackend,
      dependencyContext,
      executionDependencies,
      withExecutionAdmission,
      commitUsageSource,
      publishThreadUsage,
      extensionService,
      usageRepository,
      executionIngest,
      ensureIngest,
      awaitIngestSettled,
      flushIngest,
      deliverResultEvents,
      publishInteractiveActivity,
      createObservedSubmission,
      claimTurnObserver,
      releaseTurnObserver,
      claimQueuedTurn,
      backendLayer,
      acquiredDependencies,
      executionStartFailureMessage,
      ingestFailureMessage,
      unavailable: input.unavailable,
      temporaryThreadTitle,
      encodeJson: input.encodeJson,
    })
    return {
      ownerScope,
      pendingTurnCapacity,
      watchedThreadIds: watched,
      queueMutationEvent: input.queueMutationEvent,
      turnMutationAdmission,
      turnChanges,
      dirtyTurnObservers,
      rootTurnOwner,
      titleExecutionId,
      extensionService,
      acquiredDependencies,
      withExecutionAdmission,
      commitUsageSource,
      publishThreadUsage,
      replacementAdmission,
      replacementState,
      activeWorkflows,
      rawBackend,
      acquiredBackend,
      backendLayer,
      dependencyContext,
      executionDependencies,
      usageRepository,
      executionIngest,
      ensureIngest,
      awaitIngestSettled,
      flushIngest,
      deliverResultEvents,
      createForSubmission,
      claimTurnObserver,
      releaseTurnObserver,
      createObservedSubmission,
      claimQueuedTurn,
      ...execution,
    }
  })
