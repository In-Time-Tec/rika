import { OperationError } from "../operation-error"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import { Context, Effect, Ref } from "effect"
import type { QueueItem } from "./interactive-runtime-event"
import { promotePendingTurns } from "./pending-turn-promotion"
import { operationError, operationFailureDetail } from "../operation-error"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"

export const queueItem = (turn: Turn.AgentExecutionTurn): QueueItem => {
  const attachments = turn.promptParts
    ?.filter((part) => part.type === "image")
    .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
  const base = {
    id: turn.id,
    prompt: turn.prompt,
    createdAt: turn.createdAt,
  }
  return attachments === undefined || attachments.length === 0 ? base : { ...base, attachments }
}

export type InteractiveQueueInput = Pick<
  InteractiveRuntimeContext,
  | "options"
  | "pendingTurnCapacity"
  | "rootTurnOwner"
  | "prepareExecution"
  | "notifyThreadSummaries"
  | "notifyTurnChanged"
  | "setTurnStatus"
  | "claimQueuedTurn"
  | "emit"
  | "releaseTurnObserver"
  | "executionStartFailureMessage"
  | "queueMutationEvent"
  | "dependencyContext"
  | "executionDependencies"
  | "acquiredBackend"
  | "interactiveThread"
>

export const makeInteractiveQueue = (input: InteractiveQueueInput) => {
  const {
    pendingTurnCapacity,
    rootTurnOwner,
    prepareExecution,
    notifyThreadSummaries,
    notifyTurnChanged,
    setTurnStatus,
    claimQueuedTurn,
    emit,
    releaseTurnObserver,
    executionStartFailureMessage,
    dependencyContext,
    acquiredBackend,
  } = input
  const readQueue = Effect.fn("ProductOperation.interactive.readQueue")(function* (
    threadId: Thread.ThreadId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = Context.get(dependencyContext, TurnRepository.Service)
    const queue = yield* turns.readQueue(threadId)
    dispatch({
      _tag: "QueueUpdated",
      selectionEpoch: 0,
      threadId,
      revision: queue.revision,
      queuedCount: queue.queuedCount,
      change: { _tag: "Reset", items: queue.turns.map(queueItem) },
    })
  })
  const drainQueued = (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ): Effect.Effect<
    number,
    | OperationError
    | TurnRepository.QueueFull
    | ExecutionGateway.StartTurnFailure
    | ExecutionGateway.WatchTurnFailure
    | TurnRepository.RepositoryError
    | import("@rika/product/transcript-repository").RepositoryError,
    | ResolvedContext.Service
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  > =>
    Effect.gen(function* () {
      const turns = Context.get(dependencyContext, TurnRepository.Service)
      return yield* promotePendingTurns({
        thread,
        dispatch,
        turns,
        backend: acquiredBackend,
        pendingCapacity: pendingTurnCapacity,
        prepareExecution: (turn, workspace, persist) =>
          prepareExecution(turn, workspace, persist).pipe(
            Effect.provide(input.executionDependencies),
            Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
          ),
        owner: rootTurnOwner,
        notifyThreadSummaries: notifyThreadSummaries.pipe(
          Effect.provide(input.executionDependencies),
          Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
        ),
        notifyTurnChanged,
        setTurnStatus: (id, status, now) =>
          setTurnStatus(id, status, now).pipe(
            Effect.provide(input.executionDependencies),
            Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
          ),
        queueMutationEvent: input.queueMutationEvent,
        claimQueuedTurn: (threadId, now) =>
          claimQueuedTurn(threadId, now).pipe(
            Effect.mapError((error) => operationError(operationFailureDetail(error), error)),
          ),
        emit,
        releaseTurnObserver,
        makeTurnId: () => input.options.makeTurnId,
        failureMessage: executionStartFailureMessage,
      })
    })
  const promoteThread = Effect.fn("ProductOperation.interactive.promoteThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    yield* drainQueued(thread, dispatch)
  })
  const settleThread = Effect.fn("ProductOperation.interactive.settleThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    yield* promoteThread(thread, dispatch).pipe(
      Effect.catch(() => drainQueued(thread, dispatch).pipe(Effect.asVoid)),
      Effect.orElseSucceed(() => undefined),
    )
  })
  const activeInThread = Effect.fn("ProductOperation.interactive.activeInThread")(function* (
    threadId: Thread.ThreadId,
  ) {
    const turns = Context.get(dependencyContext, TurnRepository.Service)
    const turn = yield* turns.findActive(threadId)
    if (turn === undefined) return yield* operationError("No active turn")
    return turn
  })
  const active = Effect.gen(function* () {
    const thread = yield* Ref.get(input.interactiveThread)
    if (thread === undefined) return yield* operationError("No thread selected")
    return yield* activeInThread(thread.id)
  }).pipe(Effect.withSpan("ProductOperation.interactive.active"))
  const threadForTurn = Effect.fn("ProductOperation.interactive.threadForTurn")(function* (
    turn: import("@rika/product/turn-record").Turn,
  ) {
    const thread = yield* Context.get(dependencyContext, ThreadRepository.Service).get(turn.threadId)
    if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
    return thread
  })
  return { readQueue, drainQueued, promoteThread, settleThread, activeInThread, active, threadForTurn }
}
