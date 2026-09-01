import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnResult from "@rika/product/thread-result"
import type * as RootTurnOwner from "../queue/root-owner"
import { Clock, Effect } from "effect"

export interface Interface {
  readonly request: (threadId: Thread.ThreadId) => Effect.Effect<void, Error>
  readonly reconcile: Effect.Effect<void, never>
}

export const make = (input: {
  readonly threads: Pick<ThreadRepository.Interface, "requestDeletion" | "pendingDeletions" | "completeDeletion">
  readonly turns: Pick<TurnRepository.Interface, "list">
  readonly sessions: ExecutionSessionLifecycle.Interface
  readonly rootTurns: Pick<RootTurnOwner.Interface, "quiesceThread">
  readonly withThreadMutation: <A, E, R>(
    threadId: Thread.ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}): Interface => {
  // Title Runs live in their own isolated Sessions (one per ExecutionLink), so thread deletion
  // must cancel and await each persisted title session as well.
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
        input.sessions
          .requestCancellation({ sessionId, reason: "Thread deleted" })
          .pipe(Effect.andThen(input.sessions.awaitTerminal({ sessionId }))),
      { concurrency: 4, discard: true },
    )
  })
  const cleanup = Effect.fn("ThreadDeletion.cleanup")(function* (threadId: Thread.ThreadId) {
    yield* input.rootTurns.quiesceThread(threadId)
    yield* input.sessions.requestCancellation({ sessionId: String(threadId), reason: "Thread deleted" })
    yield* settleTitleSessions(threadId)
    yield* input.sessions.awaitTerminal({ sessionId: String(threadId) })
    yield* input.threads.completeDeletion(threadId)
  })
  const request = Effect.fn("ThreadDeletion.request")(function* (threadId: Thread.ThreadId) {
    yield* input.withThreadMutation(threadId, input.threads.requestDeletion(threadId, yield* Clock.currentTimeMillis))
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
