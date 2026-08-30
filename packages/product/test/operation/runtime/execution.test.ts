import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ProductOperation from "@rika/product/product-operation"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import type * as TurnQueuePromotion from "../../../src/thread/repository/turn-queue"
import * as RootTurnOwner from "../../../src/thread/queue/root-owner"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { OperationError } from "../../../src/operation/error"
import {
  settleInteractiveSubmission,
  type InteractiveSubmissionContext,
} from "../../../src/operation/interactive/turn/admission"
import { promotePendingTurns } from "../../../src/operation/interactive/turn/queue"
import { run as runNoninteractive } from "../../../src/operation/dispatch/noninteractive"
import type { Dependencies as NoninteractiveDependencies } from "../../../src/operation/dispatch/noninteractive-contract"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../../src/thread/queue/pending-policy"
import type { InteractiveEvent } from "../../../src/operation/interactive/session-event"

class InteractiveSubmissionService extends Context.Service<
  InteractiveSubmissionService,
  InteractiveSubmissionContext
>()("@rika/product/test/operation/runtime/execution.test/InteractiveSubmissionService") {}

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("linked-settlement-thread"),
  workspace: "/workspace",
  title: "Linked settlement",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 0,
  updatedAt: 0,
}

const route = ExecutionRouteSnapshot.testExecutionRoute()

const turn = (id: string, status: "queued" | "running" = "running"): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(id),
  threadId: thread.id,
  prompt: id,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: route,
  status,
  createdAt: 0,
  updatedAt: 0,
})

const executionLink = (value: Turn.AgentExecutionTurn): ExecutionGateway.ExecutionLink => ({
  runId: `${value.id}-run`,
  threadId: value.threadId,
  turnId: value.id,
})

const queueChange = (
  value: Turn.AgentExecutionTurn,
  revision: number,
  queuedCount: number,
): TurnQueuePromotion.QueueItemChange => ({
  threadId: value.threadId,
  revision,
  queuedCount,
  becameNonempty: false,
  change: { _tag: "Removed", turnId: value.id },
})

describe("linked Turn settlement authority", () => {
  it.effect("does not fail or cancel a linked interactive Turn after its local observer fails", () =>
    Effect.gen(function* () {
      const admitted = turn("interactive")
      const persisted = { ...admitted, executionLink: executionLink(admitted) }
      const turns = TurnRepository.Service.of({ get: () => Effect.succeed(persisted) })

      for (const outcome of [
        Exit.fail(ExecutionGateway.WatchTurnFailure.make({ message: "watch failed" })),
        Exit.interrupt(1),
      ]) {
        const statusWrites = new Array<string>()
        const events = new Array<InteractiveEvent>()
        let settlements = 0
        const submissions = InteractiveSubmissionService.of({
          setTurnStatus: (_id, status) =>
            Effect.sync(() => {
              statusWrites.push(status)
              return { ...persisted, status }
            }),
          settleThread: () => Effect.sync(() => (settlements += 1)),
          emit: (_dispatch, event) => events.push(event),
        })
        const result = yield* settleInteractiveSubmission(submissions, {
          thread,
          turn: admitted,
          outcome,
          dispatch: () => undefined,
        }).pipe(Effect.provideService(TurnRepository.Service, turns))

        expect(result).toEqual({ _tag: "settled" })
        expect(statusWrites).toEqual([])
        expect(settlements).toBe(0)
        expect(events).toEqual([])
      }
    }),
  )

  it.effect("stops queue promotion when a linked promoted Turn loses its local observer", () =>
    Effect.gen(function* () {
      const queued = [turn("queued-first", "queued"), turn("queued-second", "queued")]
      const persisted = new Map<string, Turn.AgentExecutionTurn>(queued.map((value) => [String(value.id), value]))
      const claims = queued.map((value, index) => ({ turn: value, token: `claim-${index}` }))
      const events = new Array<InteractiveEvent>()
      const statusWrites = new Array<{ readonly id: string; readonly status: string }>()
      let nextClaim = 0
      let released = 0

      const turns = TurnRepository.Service.of({
        readQueue: () =>
          Effect.succeed({
            threadId: thread.id,
            revision: nextClaim,
            queuedCount: queued.length - nextClaim,
            turns: queued.slice(nextClaim),
          }),
        get: (id) => Effect.succeed(persisted.get(String(id))),
        finishQueuedClaim: (claim: TurnQueuePromotion.QueueClaim, status: "running" | "failed") =>
          Effect.sync(() => {
            const updated = { ...claim.turn, status }
            persisted.set(String(claim.turn.id), updated)
            return {
              _tag: "Transitioned" as const,
              turn: updated,
              queue: queueChange(claim.turn, nextClaim, queued.length - nextClaim),
            }
          }),
      })
      const owner = {
        ...(yield* RootTurnOwner.make(turns, TranscriptRepository.Service.of({}), ExecutionGateway.Service.of({}))),
        startTurn: (input: ExecutionGateway.StartTurn) =>
          Effect.sync(() => {
            const current = persisted.get(input.turnId)!
            const link = executionLink(current)
            persisted.set(input.turnId, { ...current, executionLink: link })
            return link
          }),
        watchTurn: () => Effect.fail(ExecutionGateway.WatchTurnFailure.make({ message: "local watch failed" })),
      }

      const claimed = yield* promotePendingTurns({
        thread,
        dispatch: () => undefined,
        turns,
        backend: ExecutionGateway.Service.of({}),
        pendingCapacity: 2,
        prepareExecution: (value) => Effect.succeed({ prompt: value.prompt, promptParts: undefined, messages: [] }),
        owner,
        notifyThreadSummaries: Effect.void,
        notifyTurnChanged: () => Effect.void,
        setTurnStatus: (id, status) =>
          Effect.sync(() => {
            statusWrites.push({ id: String(id), status })
            const current = persisted.get(String(id))!
            const updated = { ...current, status }
            persisted.set(String(id), updated)
            return updated
          }),
        queueMutationEvent: (change) => {
          if (change.change._tag !== "Removed") throw new Error("expected a removed queue item")
          return {
            _tag: "QueueUpdated",
            selectionEpoch: 0,
            threadId: change.threadId,
            revision: change.revision,
            queuedCount: change.queuedCount,
            change: { _tag: "Removed", turnId: change.change.turnId },
          }
        },
        claimQueuedTurn: () =>
          Effect.sync(() => {
            const claim = claims[nextClaim]
            nextClaim += claim === undefined ? 0 : 1
            return claim
          }),
        releaseTurnObserver: () => Effect.sync(() => (released += 1)),
        emit: (_dispatch, event) => events.push(event),
        makeTurnId: () => Effect.succeed(Turn.TurnId.make("unused-retry")),
        failureMessage: "local observer failed",
      })

      expect(claimed).toBe(1)
      expect(nextClaim).toBe(1)
      expect(released).toBe(1)
      expect(statusWrites).toEqual([])
      expect(persisted.get("queued-first")).toMatchObject({
        status: "running",
        executionLink: { runId: "queued-first-run" },
      })
      expect(persisted.get("queued-second")).toMatchObject({ status: "queued" })
      expect(persisted.get("queued-second")).not.toHaveProperty("executionLink")
      expect(events.filter((event) => event._tag === "ExecutionFailed")).toEqual([])
    }),
  )

  it.effect("releases a durable queue claim when promotion defects before consuming it", () =>
    Effect.gen(function* () {
      const queued = turn("defective-promotion", "queued")
      const claim = { turn: queued, token: "defective-claim" }
      let released = 0
      const turns = TurnRepository.Service.of({
        readQueue: () => Effect.succeed({ threadId: thread.id, revision: 0, queuedCount: 1, turns: [queued] }),
        releaseQueuedClaim: (candidate: TurnQueuePromotion.QueueClaim) =>
          Effect.sync(() => {
            expect(candidate).toEqual(claim)
            released += 1
            return true
          }),
      })

      const result = yield* Effect.exit(
        promotePendingTurns({
          thread,
          dispatch: () => undefined,
          turns,
          backend: ExecutionGateway.Service.of({}),
          pendingCapacity: 1,
          prepareExecution: () => Effect.die("promotion defect"),
          owner: yield* RootTurnOwner.make(turns, TranscriptRepository.Service.of({}), ExecutionGateway.Service.of({})),
          notifyThreadSummaries: Effect.void,
          notifyTurnChanged: () => Effect.void,
          setTurnStatus: () => Effect.die("unused"),
          queueMutationEvent: () => Effect.die("unused"),
          claimQueuedTurn: () => Effect.succeed(claim),
          releaseTurnObserver: () => Effect.void,
          emit: () => undefined,
          makeTurnId: () => Effect.die("unused"),
          failureMessage: "promotion failed",
        }),
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(Cause.hasDies(result.cause)).toBe(true)
      expect(released).toBe(1)
    }),
  )

  it.effect("does not fail a linked noninteractive Turn after its local watcher fails", () =>
    Effect.gen(function* () {
      const submitted = turn("noninteractive")
      let persisted: Turn.AgentExecutionTurn = submitted
      let queueReads = 0
      let starts = 0
      let releases = 0
      const statusWrites = new Array<string>()
      const turns = TurnRepository.Service.of({
        readQueue: () =>
          Effect.sync(() => {
            queueReads += 1
            return { threadId: thread.id, revision: 0, queuedCount: 0, turns: [] }
          }),
        get: () => Effect.succeed(persisted),
        list: () => Effect.succeed([persisted]),
      })
      const threads = ThreadRepository.Service.of({ get: () => Effect.succeed(thread) })
      const executionDependencies = Context.empty().pipe(
        Context.add(ThreadRepository.Service, threads),
        Context.add(TurnRepository.Service, turns),
      )
      const failure = ExecutionGateway.WatchTurnFailure.make({ message: "local watcher failed" })
      const dependencies: NoninteractiveDependencies = {
        defaultWorkspace: thread.workspace,
        pendingTurnCapacity: 2,
        makeThreadId: Effect.die("existing thread must be reused"),
        makeTurnId: Effect.succeed(submitted.id),
        resolveExecutionRoute: () => Effect.succeed(route),
        createObservedSubmission: () =>
          Effect.sync(() => {
            persisted = submitted
            return { turn: submitted, claimed: true }
          }),
        ensureTurnSummary: () => Effect.void,
        setTurnStatus: (_id, status) =>
          Effect.sync(() => {
            statusWrites.push(status)
            persisted = { ...persisted, status }
            return persisted
          }),
        publishInteractiveActivity: (_origin, event) => event,
        rootTurnOwner: {
          ...(yield* RootTurnOwner.make(turns, TranscriptRepository.Service.of({}), ExecutionGateway.Service.of({}))),
          startTurn: () =>
            Effect.sync(() => {
              starts += 1
              const link = executionLink(persisted)
              persisted = { ...persisted, executionLink: link }
              return link
            }),
          watchTurn: () => Effect.fail(failure),
        },
        prepareExecution: (value) => Effect.succeed({ prompt: value.prompt, promptParts: undefined, messages: [] }),
        claimQueuedTurn: () => Effect.void,
        releaseTurnObserver: () => Effect.sync(() => (releases += 1)),
        queueMutationEvent: () => Effect.die("queue is empty"),
        executionDependencies,
        staleQueuedTurnsError,
        queuedTurnPromoteMaxAgeMs,
        operationError: (message) => Effect.fail(OperationError.make({ message })),
        unavailable: (input, message) => ProductOperation.OperationUnavailable.make({ operation: input._tag, message }),
      }

      const result = yield* runNoninteractive(
        {
          _tag: "Run",
          prompt: ["noninteractive"],
          threadId: String(thread.id),
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        },
        dependencies,
      ).pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Success") return
      expect(result.failure._tag).toBe("OperationUnavailable")
      expect(result.failure.message).toContain("local watcher failed")
      expect(starts).toBe(1)
      expect(releases).toBe(1)
      expect(queueReads).toBe(1)
      expect(statusWrites).toEqual(["running"])
      expect(persisted).toMatchObject({
        status: "running",
        executionLink: { runId: "noninteractive-run" },
      })
    }),
  )
})
