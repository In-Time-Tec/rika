import * as Thread from "@rika/product/thread-record"
import * as ExtensionOperations from "../contract/extension"
import * as ConfigOperations from "../contract/configuration"
import { Console, Effect, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../thread/queue/pending-policy"
import { OperationUnavailable } from "../contract/product"
import { Service } from "../contract/product-service"
import type { Input } from "../contract/product"
import { OperationError, operationError } from "../error"
import type { Interface } from "../contract/product-service"
import * as ProductOperationSchedule from "../run/schedule"
import * as ProductOperationRuntimeState from "../runtime/state"
import * as ProductOperationService from "../run/service"
import type { ProductLayerOptions } from "../foundation/options"
import type { InteractiveEvent } from "../interactive/session-event"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
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

type ProductLayerError<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error,
  TranscriptError extends Error,
> =
  | ThreadError
  | TurnError
  | BackendError
  | ThreadSummaryError
  | TranscriptError
  | OperationError
  | OperationUnavailable

export const productLayer = <
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
>(
  options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
): Layer.Layer<
  Service,
  ThreadError | TurnError | BackendError | ThreadSummaryError | TranscriptError | OperationError | OperationUnavailable,
  never
> =>
  Layer.effect(
    Service,
    Effect.gen(function* (): Effect.gen.Return<
      Interface,
      ProductLayerError<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
      Scope.Scope
    > {
      const ownerScope = yield* Effect.scope
      const console = yield* Console.Console
      const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
      const path = yield* Effect.serviceOption(Path.Path)
      let activitySequence = 0
      // System projections have no originating client session and must reach session 0.
      const systemActivityOrigin = -1
      const interactiveSinks = new Map<number, (origin: number, event: InteractiveEvent) => void>()
      const sessionThreadViews = new Map<number, () => string | undefined>()
      const publishInteractiveActivity = (origin: number, event: InteractiveEvent): InteractiveEvent => {
        const published =
          event._tag === "TurnStarted" || event._tag === "TurnSettled"
            ? { ...event, activitySequence: (activitySequence += 1) }
            : event
        for (const [sessionId, sink] of interactiveSinks) if (sessionId !== origin) sink(origin, published)
        return published
      }
      /**
       * A Turn is the only place goal usage can be accounted honestly: it is where the work the
       * goal spent actually settles. Publishing the goal here is what makes the indicator live
       * rather than a value the TUI invented. A Thread with no goal publishes nothing.
       */
      const publishGoal = (threadId: string) =>
        options.goals === undefined
          ? Effect.void
          : options.goals.get(threadId).pipe(
              Effect.map((goal) =>
                publishInteractiveActivity(
                  systemActivityOrigin,
                  goal === undefined
                    ? {
                        _tag: "GoalChanged",
                        threadId,
                      }
                    : {
                        _tag: "GoalChanged",
                        threadId,
                        goal: {
                          objective: goal.objective,
                          status: goal.status,
                          startedAtMillis: goal.startedAtMillis,
                        },
                      },
                ),
              ),
              Effect.asVoid,
              Effect.ignore,
            )
      const publishTurnSettled = (turn: import("@rika/product/turn-record").Turn, responseArrived?: boolean) => {
        const status = turn.status
        if (status !== "completed" && status !== "failed" && status !== "cancelled") return Effect.void
        return Effect.sync(() => {
          const event: Extract<InteractiveEvent, { readonly _tag: "TurnSettled" }> = {
            _tag: "TurnSettled",
            selectionEpoch: 0,
            activitySequence: 0,
            threadId: turn.threadId,
            turnId: turn.id,
            status,
          }
          publishInteractiveActivity(
            systemActivityOrigin,
            responseArrived === undefined ? event : { ...event, agentResponseArrived: responseArrived },
          )
        }).pipe(Effect.andThen(publishGoal(String(turn.threadId))), Effect.asVoid)
      }
      const state = yield* ProductOperationRuntimeState.makeProductOperationRuntimeState({
        options,
        ownerScope,
        publishInteractiveActivity,
        publishTurnSettled,
        interactiveSinks,
        sessionThreadViews,
        activitySequence,
        unavailable,
        operationError,
        encodeJson,
        staleQueuedTurnsError,
        queuedTurnPromoteMaxAgeMs,
      }).pipe(Effect.mapError((error) => operationError(String(error))))
      const schedule = yield* ProductOperationSchedule.makeProductOperationSchedule({
        options,
        ownerScope,
        makeInteractiveSession: state.makeInteractiveSession,
        repairThreadSummaries: state.repairThreadSummaries,
        executionDependencies: state.executionDependencies,
      })
      yield* state.rootTurnOwner.install({ run: () => Effect.void })
      return ProductOperationService.makeProductOperationService({
        options,
        state,
        schedule,
        console,
        fileSystem: Option.getOrUndefined(fileSystem),
        path: Option.getOrUndefined(path),
        executionDependencies: state.executionDependencies,
        stopActiveExecutionWorkWithProjection: state.stopActiveExecutionWorkWithProjection,
        closeAdmissions: state.closeAdmissions,
        unavailable,
        operationError,
        publishInteractiveActivity,
        encodeJson,
        queueMutationEvent: state.queueMutationEvent,
        extensionOperations: ExtensionOperations,
        configOperations: ConfigOperations,
        notifyThreadSummaries: state.notifyThreadSummaries,
        writeThread,
        requireThread: (repository, id) =>
          requireThread(repository, id).pipe(Effect.mapError((error) => operationError(error.message, error))),
        markdownExport,
        staleQueuedTurnsError,
        queuedTurnPromoteMaxAgeMs,
      })
    }),
  )
