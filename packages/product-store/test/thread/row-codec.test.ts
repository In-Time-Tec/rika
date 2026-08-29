import { describe, expect, it } from "@effect/vitest"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadDeletion from "@rika/product/thread-deletion"
import type * as RootTurnOwner from "@rika/product/root-turn-owner"
import { rankCase, statusRank, threadState, threadStateFromRank } from "@rika/product/thread-state"
import * as ThreadRepository from "../../src/thread/memory-repository"
import * as TurnRepository from "../../src/turn/memory/repository"
import { Effect } from "effect"

const viaRank = (statuses: ReadonlyArray<string>) =>
  threadStateFromRank({
    rank: statuses.reduce((highest, status) => Math.max(highest, statusRank(status)), 0),
    lastStatus: statuses.at(-1),
  })

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
    const rootTurns: RootTurnOwner.Interface = {
      claim: () => Effect.die("unused"),
      release: () => Effect.die("unused"),
      claimQueued: () => Effect.die("unused"),
      startTurn: () => Effect.die("unused"),
      recoverExecutionAdmissions: Effect.die("unused"),
      prepareSteering: () => Effect.die("unused"),
      prepareQueuedSteering: () => Effect.die("unused"),
      recoverSteeringAdmissions: Effect.die("unused"),
      acknowledgeSteeringRejection: () => Effect.die("unused"),
      watchTurn: () => Effect.die("unused"),
      install: () => Effect.die("unused"),
      accepted: () => Effect.die("unused"),
      quiesceThread: () => Effect.sync(() => calls.push("quiesce")).pipe(Effect.asVoid),
    }
    const turns = yield* TurnRepository.makeMemory()
    const saga = ThreadDeletion.make({
      threads: repository,
      turns,
      sessions,
      rootTurns,
      withThreadMutation: (_threadId, effect) => effect,
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

it.effect(
  "cancels and awaits isolated title-run sessions before completing deletion, without kernel cleanup for them",
  () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const threadId = Thread.ThreadId.make("thread-title")
      yield* repository.create({ id: threadId, workspace: "/work", title: "Thread", now: 1 })
      const calls: Array<string> = []
      const sessions = ExecutionSessionLifecycle.Service.of({
        requestCancellation: (input) => Effect.sync(() => calls.push(`cancel:${input.sessionId}`)).pipe(Effect.asVoid),
        awaitTerminal: (input) => Effect.sync(() => calls.push(`terminal:${input.sessionId}`)).pipe(Effect.asVoid),
        closeKernel: (input) => Effect.sync(() => calls.push(`close:${input.sessionId}`)).pipe(Effect.asVoid),
        dropKernelState: (input) => Effect.sync(() => calls.push(`drop:${input.sessionId}`)).pipe(Effect.asVoid),
      })
      const rootTurns: RootTurnOwner.Interface = {
        claim: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
        claimQueued: () => Effect.die("unused"),
        startTurn: () => Effect.die("unused"),
        recoverExecutionAdmissions: Effect.die("unused"),
        prepareSteering: () => Effect.die("unused"),
        prepareQueuedSteering: () => Effect.die("unused"),
        recoverSteeringAdmissions: Effect.die("unused"),
        acknowledgeSteeringRejection: () => Effect.die("unused"),
        watchTurn: () => Effect.die("unused"),
        install: () => Effect.die("unused"),
        accepted: () => Effect.die("unused"),
        quiesceThread: () => Effect.sync(() => calls.push("quiesce")).pipe(Effect.asVoid),
      }
      const turns = yield* TurnRepository.makeMemory([
        Turn.AgentExecutionTurn.make({
          id: Turn.TurnId.make("turn-1"),
          threadId,
          prompt: "prompt",
          status: "completed",
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          executionLink: {
            runId: "run-1",
            titleRunId: "run-1:title",
            turnId: "turn-1",
            threadId: String(threadId),
          },
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 1,
          updatedAt: 1,
        }),
      ])
      const saga = ThreadDeletion.make({
        threads: repository,
        turns,
        sessions,
        rootTurns,
        withThreadMutation: (_threadId, effect) => effect,
      })
      yield* saga.request(threadId)
      expect(calls).toEqual([
        "quiesce",
        "cancel:thread-title",
        "cancel:run-1:title",
        "terminal:run-1:title",
        "terminal:thread-title",
        "close:thread-title",
        "drop:thread-title",
      ])
      expect(yield* repository.pendingDeletions).toEqual([])
    }),
)
describe("thread state", () => {
  it("reports a durable execution wait as active work", () => {
    expect(threadState(["waiting"])).toBe("running")
    expect(threadState(["running", "waiting"])).toBe("running")
    expect(threadState(["waiting", "running"])).toBe("running")
  })

  it("reports an error only once nothing is active", () => {
    expect(threadState(["failed"])).toBe("error")
    expect(threadState(["failed", "queued"])).toBe("queued")
    expect(threadState(["failed", "running"])).toBe("running")
    expect(threadState(["completed"])).toBe("idle")
    expect(threadState([])).toBe("idle")
  })

  it("treats accepted as running", () => {
    expect(threadState(["accepted"])).toBe("running")
  })

  it("agrees between the in-memory rollup and the SQL rank path", () => {
    for (const statuses of [
      ["running", "waiting"],
      ["queued"],
      ["failed"],
      ["completed"],
      ["accepted", "queued"],
      ["cancelled", "failed"],
    ])
      expect(viaRank(statuses), statuses.join(",")).toBe(threadState(statuses))
  })

  it("builds the SQL ladder from the same table", () => {
    const sql = rankCase("turn.status")
    expect(sql).toContain("WHEN turn.status IN ('accepted', 'running', 'waiting', 'cancelling') THEN 2")
    expect(sql).toContain("WHEN turn.status IN ('queued') THEN 1")
    expect(sql.endsWith("ELSE 0 END")).toBe(true)
  })
})
