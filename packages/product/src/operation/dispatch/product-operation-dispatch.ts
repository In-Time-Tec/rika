import * as Thread from "@rika/product/thread-record"
import * as AuthenticationOperation from "./authentication-operation-dispatch"
import * as ExecutionRecovery from "./execution-recovery-dispatch"
import * as ExtensionOperations from "./extension-operation-dispatch"
import * as ConfigOperations from "./configuration-operation-dispatch"
import { Console, Deferred, Effect, Layer, Schema, Scope } from "effect"
import { awaitSessionQuiescence, hasActiveExecutionWork } from "../../execution/lifecycle/product-execution-quiescence"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import { OperationUnavailable } from "../contract/product-operation-errors"
import { Service } from "../contract/product-operation-service"
import type { Input } from "../contract/product-operation"
import { OperationError, operationError } from "../operation-error"
import type { Interface } from "../contract/product-operation-service"
import { isTerminalStatus } from "../../execution/contract/execution-status"
import { makeProductOperationSchedule } from "./product-operation-schedule"
import { makeProductOperationRuntimeState } from "./product-operation-runtime-state"
import { makeProductOperationService } from "./product-operation-service"
import type { ProductLayerOptions } from "./product-operation-options"

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const unavailable = (input: Input, message = `${input._tag} is specified but not implemented yet`) =>
  OperationUnavailable.make({ operation: input._tag, message })
const writeThread = (thread: Thread.Thread) => Console.log(encodeJson(thread))
const requireThread = Effect.fn("ProductOperation.requireThread")(function* (
  repository: import("@rika/product/thread-repository").Interface,
  id: string,
) {
  const thread = yield* repository.get(Thread.ThreadId.make(id))
  if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
  return thread
})
const markdownExport = (thread: Thread.Thread, turns: ReadonlyArray<import("@rika/product/turn-record").Turn>) =>
  [
    `# ${thread.title}`,
    "",
    `- Thread: ${thread.id}`,
    `- Workspace: ${thread.workspace}`,
    `- Labels: ${thread.labels.join(", ") || "None"}`,
    "",
    ...turns.flatMap((turn, index) => [`## Turn ${index + 1}`, "", `Status: ${turn.status}`, "", turn.prompt, ""]),
  ].join("\n")

export const runAuth = AuthenticationOperation.run
export const reconcile = ExecutionRecovery.reconcile

type ProductLayerError<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error,
  TranscriptError extends Error,
  ThreadInteractionError extends Error,
  UsageError extends Error,
> =
  | ThreadError
  | TurnError
  | BackendError
  | ThreadSummaryError
  | TranscriptError
  | ThreadInteractionError
  | UsageError
  | OperationError
  | OperationUnavailable

export const productLayer = <
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
  ThreadInteractionError extends Error = never,
  UsageError extends Error = never,
>(
  options: ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >,
): Layer.Layer<
  Service,
  | ThreadError
  | TurnError
  | BackendError
  | ThreadSummaryError
  | TranscriptError
  | ThreadInteractionError
  | UsageError
  | OperationError
  | OperationUnavailable,
  never
> =>
  Layer.effect(
    Service,
    Effect.gen(function* (): Effect.gen.Return<
      Interface,
      ProductLayerError<
        ThreadError,
        TurnError,
        BackendError,
        ThreadSummaryError,
        TranscriptError,
        ThreadInteractionError,
        UsageError
      >,
      Scope.Scope
    > {
      const ownerScope = yield* Effect.scope
      let activitySequence = 0
      const interactiveSinks = new Map<number, (origin: number, event: any) => void>()
      const sessionThreadViews = new Map<number, () => string | undefined>()
      const publishInteractiveActivity = (origin: number, event: any) => {
        activitySequence += 1
        for (const [sessionId, sink] of interactiveSinks) if (sessionId !== origin) sink(origin, event)
      }
      const state = yield* makeProductOperationRuntimeState({
        options,
        ownerScope,
        publishInteractiveActivity,
        interactiveSinks,
        sessionThreadViews,
        activitySequence,
        unavailable,
        operationError,
        encodeJson,
        awaitSessionQuiescence,
        staleQueuedTurnsError,
        queuedTurnPromoteMaxAgeMs,
      }).pipe(Effect.mapError((error) => operationError(String(error))))
      const schedule = yield* makeProductOperationSchedule({
        options,
        ...state,
        publishInteractiveActivity,
        hasActiveExecutionWork,
        stopActiveExecutionWorkWithProjection: state.stopActiveExecutionWorkWithProjection,
        isTerminalStatus,
        queueMutationEvent: state.queueMutationEvent,
      })
      yield* state.rootTurnOwner.install({
        run: schedule.scheduleReconcile.pipe(
          Effect.flatMap((value: Deferred.Deferred<void>) => Deferred.await(value)),
          Effect.asVoid,
          Effect.mapError((error) => operationError(String(error))),
        ),
        reconcile: schedule.scheduleReconcile.pipe(
          Effect.flatMap((value: Deferred.Deferred<void>) => Deferred.await(value)),
          Effect.asVoid,
          Effect.mapError((error) => operationError(String(error))),
        ),
      })
      const rootReconcile: Effect.Effect<void, Error> = state.rootTurnOwner.reconcile
      yield* Effect.forkIn(rootReconcile, ownerScope).pipe(Effect.mapError((error) => operationError(String(error))))
      return makeProductOperationService({
        options,
        state,
        schedule,
        executionDependencies: state.executionDependencies,
        hasActiveExecutionWork,
        stopActiveExecutionWorkWithProjection: state.stopActiveExecutionWorkWithProjection,
        replacementAdmission: state.replacementAdmission,
        replacementState: state.replacementState,
        activeWorkflows: state.activeWorkflows,
        rawBackend: state.rawBackend,
        unavailable,
        operationError,
        publishInteractiveActivity,
        encodeJson,
        runAuth,
        queueMutationEvent: state.queueMutationEvent,
        extensionOperations: ExtensionOperations,
        configOperations: ConfigOperations,
        notifyThreadSummaries: state.notifyThreadSummaries,
        writeThread,
        requireThread,
        markdownExport,
        turnMutationAdmission: state.turnMutationAdmission,
        pendingTurnCapacity: state.pendingTurnCapacity,
        awaitSessionQuiescence,
        staleQueuedTurnsError,
        queuedTurnPromoteMaxAgeMs,
      })
    }),
  )
