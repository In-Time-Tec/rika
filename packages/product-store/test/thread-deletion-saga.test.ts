import { expect, it } from "@effect/vitest"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as Thread from "@rika/product/thread-record"
import * as ThreadDeletion from "@rika/product/thread-deletion"
import type * as RootTurnOwner from "@rika/product/root-turn-owner"
import * as ThreadRepository from "../src/thread/memory-thread-repository"
import { Effect, Semaphore } from "effect"

it.effect("keeps a failed cleanup tombstoned and retries the exact cleanup sequence", () =>
  Effect.gen(function* () {
    const repository = yield* ThreadRepository.makeMemory()
    const threadId = Thread.ThreadId.make("thread-a")
    yield* repository.create({ id: threadId, workspace: "/work", title: "Thread", now: 1 })
    const calls: Array<string> = []
    let terminalUnavailable = true
    const sessions = ExecutionSessionLifecycle.Service.of({
      requestCancellation: () => Effect.sync(() => calls.push("cancel")).pipe(Effect.asVoid),
      awaitTerminal: () =>
        terminalUnavailable
          ? Effect.fail(ExecutionSessionLifecycle.Unavailable.make({ message: "offline" }))
          : Effect.sync(() => calls.push("terminal")).pipe(Effect.asVoid),
      closeKernel: () => Effect.sync(() => calls.push("close")).pipe(Effect.asVoid),
      dropKernelState: () => Effect.sync(() => calls.push("drop")).pipe(Effect.asVoid),
    })
    const rootTurns = {
      quiesceThread: () => Effect.sync(() => calls.push("quiesce")).pipe(Effect.asVoid),
    } as unknown as RootTurnOwner.Interface
    const saga = ThreadDeletion.make({
      threads: repository,
      sessions,
      rootTurns,
      turnMutationAdmission: yield* Semaphore.make(1),
    })
    expect((yield* Effect.exit(saga.request(threadId)))._tag).toBe("Failure")
    expect(yield* repository.get(threadId)).toBeUndefined()
    expect(yield* repository.pendingDeletions).toHaveLength(1)
    expect(
      (yield* Effect.exit(repository.create({ id: threadId, workspace: "/work", title: "Duplicate", now: 2 })))._tag,
    ).toBe("Failure")
    terminalUnavailable = false
    yield* saga.reconcile
    expect(calls).toEqual(["quiesce", "cancel", "quiesce", "cancel", "terminal", "close", "drop"])
    expect(yield* repository.pendingDeletions).toEqual([])
    expect(yield* repository.get(threadId)).toBeUndefined()
    expect((yield* repository.create({ id: threadId, workspace: "/work", title: "Reused", now: 3 })).title).toBe(
      "Reused",
    )
  }),
)
