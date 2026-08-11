import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnResult from "@rika/product/thread-result"
import type * as RootTurnOwner from "../queue/root-turn-owner"
import { Clock, Effect, Semaphore } from "effect"

export interface Interface {
  readonly request: (threadId: Thread.ThreadId) => Effect.Effect<void, Error>
  readonly reconcile: Effect.Effect<void, never>
}

export const make = (input: {
  readonly threads: ThreadRepository.Interface
  readonly turns: TurnRepository.Interface
  readonly sessions: ExecutionSessionLifecycle.Interface
  readonly rootTurns: RootTurnOwner.Interface
  readonly turnMutationAdmission: Semaphore.Semaphore
}): Interface => {
  // Title Runs live in their own isolated Sessions (one per ExecutionLink), so thread deletion
  // must cancel and await each persisted title session as well; they have no kernel of their own,
  // so closeKernel/dropKernelState stay scoped to the thread Session.
  const settleTitleSessions = Effect.fn("ThreadDeletion.settleTitleSessions")(function* (threadId: Thread.ThreadId) {
    const turns = yield* input.turns.list(threadId)
    const titleSessionIds = [
      ...new Set(
        turns.flatMap((turn) =>
          TurnResult.TurnResult.isAgentExecution(turn) && turn.executionLink?.titleRunId !== undefined
            ? [turn.executionLink.titleRunId]
            : [],
        ),
      ),
    ]
    yield* Effect.forEach(
      titleSessionIds,
      (sessionId) =>
        input.sessions.requestCancellation({ sessionId, reason: "Thread deleted" }).pipe(
          Effect.andThen(input.sessions.awaitTerminal({ sessionId })),
        ),
      { concurrency: 4, discard: true },
    )
  })
  const cleanup = Effect.fn("ThreadDeletion.cleanup")(function* (threadId: Thread.ThreadId) {
    yield* input.rootTurns.quiesceThread(threadId)
    yield* input.sessions.requestCancellation({ sessionId: String(threadId), reason: "Thread deleted" })
    yield* settleTitleSessions(threadId)
    yield* input.sessions.awaitTerminal({ sessionId: String(threadId) })
    yield* input.sessions.closeKernel({ sessionId: String(threadId) })
    yield* input.sessions.dropKernelState({ sessionId: String(threadId) })
    yield* input.threads.completeDeletion(threadId)
  })
  const request = Effect.fn("ThreadDeletion.request")(function* (threadId: Thread.ThreadId) {
    yield* input.turnMutationAdmission.withPermits(1)(
      input.threads.requestDeletion(threadId, yield* Clock.currentTimeMillis),
    )
    yield* cleanup(threadId)
  })
  const reconcile = input.threads.pendingDeletions.pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(
        pending,
        ({ threadId }) =>
          cleanup(threadId).pipe(
            Effect.catch((error) =>
              Effect.logError("thread.deletion.reconcile.failed").pipe(
                Effect.annotateLogs({ "rika.thread.id": String(threadId), "rika.failure.kind": String(error) }),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.catch((error) =>
      Effect.logError("thread.deletion.reconcile.load.failed").pipe(
        Effect.annotateLogs("rika.failure.kind", String(error)),
      ),
    ),
  )
  return { request, reconcile }
}
