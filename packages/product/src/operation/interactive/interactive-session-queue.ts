import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Clock, Context, Effect, Ref } from "effect"
import { queueItem } from "../dispatch/execution-operation-coordination"
import { promotePendingTurns } from "./pending-turn-promotion"
import { operationError } from "../operation-error"
import type { InteractiveEvent } from "./interactive-event"

export const makeInteractiveQueue = (input: any) => {
  const {
    pendingTurnCapacity,
    rootTurnOwner,
    prepareExecution,
    ensureIngest,
    notifyThreadSummaries,
    notifyTurnChanged,
    setTurnStatus,
    projectExecutionResult,
    deliverResultEvents,
    claimQueuedTurn,
    emit,
    releaseTurnObserver,
    awaitSessionQuiescence,
    executionStartFailureMessage,
    executionDependencies,
    dependencyContext,
    acquiredBackend,
  } = input
  const readQueue = Effect.fn("ProductOperation.interactive.readQueue")(function* (
    threadId: Thread.ThreadId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = Context.get(input.dependencyContext, TurnRepository.Service) as TurnRepository.Interface
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
  const drainQueued = Effect.fn("ProductOperation.interactive.drainQueued")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = Context.get(input.dependencyContext, TurnRepository.Service) as TurnRepository.Interface
    const backend = input.acquiredBackend as ExecutionBackend.Interface
    return yield* promotePendingTurns({
      thread,
      dispatch,
      turns,
      backend,
      pendingCapacity: pendingTurnCapacity,
      prepareExecution,
      ensureIngest,
      owner: rootTurnOwner,
      notifyThreadSummaries,
      notifyTurnChanged,
      setTurnStatus,
      projectExecutionResult,
      deliverResultEvents,
      queueMutationEvent: input.queueMutationEvent,
      claimQueuedTurn,
      emit,
      releaseTurnObserver,
      awaitSessionQuiescence,
      failureMessage: executionStartFailureMessage,
    })
  })
  const promoterFor =
    (dispatch: (event: InteractiveEvent) => void) =>
    (threadId: string, generation: number): Effect.Effect<number, any, any> =>
      Effect.gen(function* () {
        const threads = Context.get(input.dependencyContext, ThreadRepository.Service) as ThreadRepository.Interface
        const turns = Context.get(input.dependencyContext, TurnRepository.Service) as TurnRepository.Interface
        if (!(yield* turns.consumeQueueWake(Thread.ThreadId.make(threadId), generation))) return 0
        const thread = (yield* threads.get(Thread.ThreadId.make(threadId))) as Thread.Thread | undefined
        if (thread === undefined) return 0
        return (yield* drainQueued(thread, dispatch)) as number
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const turns = Context.get(dependencyContext, TurnRepository.Service)
            const wake = yield* turns.requestQueueWake(Thread.ThreadId.make(threadId))
            if (wake !== undefined && acquiredBackend.wakeThreadHost !== undefined)
              yield* acquiredBackend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
          }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
        Effect.catch(() =>
          Effect.gen(function* () {
            const turns = Context.get(dependencyContext, TurnRepository.Service)
            const wake = yield* turns.requestQueueWake(Thread.ThreadId.make(threadId))
            if (wake !== undefined && acquiredBackend.wakeThreadHost !== undefined)
              yield* acquiredBackend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
            return 0
          }).pipe(Effect.orElseSucceed(() => 0)),
        ),
      )
  const promoteThread = Effect.fn("ProductOperation.interactive.promoteThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const backend = input.acquiredBackend as ExecutionBackend.Interface
    if (backend.wakeThreadHost === undefined || backend.registerTurnPromoter === undefined) {
      yield* drainQueued(thread, dispatch)
      return
    }
    const turns = Context.get(input.dependencyContext, TurnRepository.Service) as TurnRepository.Interface
    const wake = yield* turns.requestQueueWake(thread.id)
    if (wake === undefined) return
    yield* backend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
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
    const turns = Context.get(input.dependencyContext, TurnRepository.Service) as TurnRepository.Interface
    const turn = yield* turns.findActive(threadId)
    if (turn === undefined) return yield* operationError("No active turn")
    return turn
  })
  const active = Effect.fn("ProductOperation.interactive.active")(function* () {
    const thread = (yield* Ref.get(input.interactiveThread)) as Thread.Thread | undefined
    if (thread === undefined) return yield* operationError("No thread selected")
    return yield* activeInThread(thread.id)
  })
  const threadForTurn = Effect.fn("ProductOperation.interactive.threadForTurn")(function* (
    turn: import("@rika/product/turn-record").Turn,
  ) {
    const thread = (yield* (
      Context.get(input.dependencyContext, ThreadRepository.Service) as ThreadRepository.Interface
    ).get(turn.threadId)) as Thread.Thread | undefined
    if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
    return thread
  })
  return { readQueue, drainQueued, promoterFor, promoteThread, settleThread, activeInThread, active, threadForTurn }
}
