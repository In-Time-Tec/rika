import * as Thread from "@rika/product/thread-record"
import * as AuthenticationOperation from "./authentication-operation-dispatch"
import * as ExecutionRecovery from "./execution-recovery-dispatch"
import * as ExtensionOperations from "./extension-operation-dispatch"
import * as ConfigOperations from "./configuration-operation-dispatch"
import { Console, Deferred, Effect, Layer, Schema } from "effect"
import { awaitSessionQuiescence, hasActiveExecutionWork } from "./execution-operation-coordination"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import { OperationUnavailable, Service } from "../contract/product-operation-service"
import type { Input } from "../contract/product-operation"
import { operationError } from "../operation-error"
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

export type { ProductLayerOptions } from "./product-operation-options"
export const runAuth = AuthenticationOperation.run
export const reconcile = ExecutionRecovery.reconcile

export const productLayer = <
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError = never,
  TranscriptError = never,
  ThreadInteractionError = never,
  UsageError = never,
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
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
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
      })
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
        run: schedule.scheduleReconcile.pipe(Effect.flatMap((value: any) => Deferred.await(value))) as any,
        reconcile: schedule.scheduleReconcile.pipe(Effect.flatMap((value: any) => Deferred.await(value))) as any,
      })
      yield* Effect.forkIn(state.rootTurnOwner.reconcile, ownerScope)
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
    }) as any,
  )
