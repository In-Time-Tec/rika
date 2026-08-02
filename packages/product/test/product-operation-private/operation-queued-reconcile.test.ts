import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { reconcile } from "../../src/operation/dispatch/product-operation-dispatch"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"

import { executionRoute } from "../../../product-store/test/support/product-test-current-state"
import { provideLayer } from "../../../product-store/test/support/operation-layer-harness"
import { reconcileDependencies, unusedExtensions } from "../../../product-store/test/support/operation-session-harness"
import { backend } from "../../../product-store/test/support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../../../product-store/test/support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("keeps a durably running promoted turn running when its promoter is interrupted", () =>
    Effect.gen(function* () {
      const thread = selectionThread("interrupted-running-thread")
      const queued: Turn.Turn = {
        id: Turn.TurnId.make("interrupted-running-turn"),
        threadId: thread.id,
        prompt: "already durable",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([queued])
      const backendEntered = yield* Deferred.make<void>()
      const blockingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: () => Deferred.succeed(backendEntered, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const repair = yield* Effect.forkChild(
        reconcile(undefined, () =>
          Effect.succeed({ prompt: queued.prompt, promptParts: undefined, extensionPin: undefined }),
        ).pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer([thread]),
              Layer.succeed(TurnRepository.Service, turns),
              Layer.succeed(ExecutionBackend.Service, blockingBackend),
            ),
          ),
        ),
      )

      yield* Deferred.await(backendEntered)
      expect(yield* turns.get(queued.id)).toMatchObject({ status: "running" })
      yield* Fiber.interrupt(repair)

      expect(yield* turns.get(queued.id)).toMatchObject({ status: "running" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 2, queuedCount: 0, turns: [] })
    }),
  )

  it.effect("reconciles review route owners through their fan-out without executing the parent prompt", () =>
    Effect.gen(function* () {
      const owner = Turn.TurnId.make("review-owner")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: owner,
          ...turnProvenance,
          threadId: Thread.ThreadId.make("review-thread"),
          prompt: "Review workspace changes",
          status: "running",
          stopIntent: "none",
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute("medium"),
          reviewFanOutId: "review:review-owner",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make(0)
      const inspections = yield* Ref.make(0)
      const routeOwnerBackend = ExecutionBackend.Service.of({
        ...backend,
        start: () => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(Effect.die("must not start"))),
        inspect: () => Effect.die("must not inspect as a turn"),
        inspectFanOut: () =>
          Ref.updateAndGet(inspections, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    fanOutId: "review:review-owner",
                    parentTurnId: owner,
                    state: "joining" as const,
                    maxConcurrency: 3,
                    join: "best-effort" as const,
                    members: [],
                  }
                : undefined,
            ),
          ),
      })
      const dependencies = Layer.mergeAll(
        reconcileDependencies(unusedExtensions),
        ThreadRepository.memoryLayer(),
        Layer.succeed(TurnRepository.Service, turns),
        Layer.succeed(ExecutionBackend.Service, routeOwnerBackend),
      )
      yield* reconcile().pipe(provideLayer(dependencies))
      expect((yield* turns.get(owner))?.status).toBe("running")
      yield* reconcile().pipe(provideLayer(dependencies))
      expect((yield* turns.get(owner))?.status).toBe("failed")
      expect(yield* Ref.get(starts)).toBe(0)
    }),
  )

  it.effect("drains past a cancelled turn but halts the queue at a failed turn", () =>
    Effect.gen(function* () {
      const threadId = Thread.ThreadId.make("terminal-fifo")
      const turns = yield* TurnRepository.makeMemory(
        ["cancelled", "failed", "completed"].map(
          (id, index): Turn.AgentExecutionTurn => ({
            _tag: "AgentExecution",
            id: Turn.TurnId.make(id),
            author: turnProvenance.author,
            lineage: turnProvenance.lineage,
            threadId,
            stopIntent: "none" as const,
            prompt: id,
            executionRoute: executionRoute(),
            status: "queued" as const,
            createdAt: index + 1,
            updatedAt: index + 1,
          }),
        ),
      )
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const terminalBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) => {
          let status: "failed" | "cancelled" | "completed" = "completed"
          if (input.turnId === "failed") status = "failed"
          else if (input.turnId === "cancelled") status = "cancelled"
          return Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.as({
              turnId: input.turnId,
              status,
              events: [],
            }),
          )
        },
      })
      yield* reconcile().pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, terminalBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["cancelled", "failed"])
      expect((yield* turns.get(Turn.TurnId.make("completed")))?.status).toBe("queued")
    }),
  )

  it.effect("holds the remaining queue after a promoted turn fails", () =>
    Effect.gen(function* () {
      const threadId = Thread.ThreadId.make("failed-holds-queue")
      const turns = yield* TurnRepository.makeMemory(
        ["failing", "later"].map(
          (id, index): Turn.AgentExecutionTurn => ({
            _tag: "AgentExecution",
            id: Turn.TurnId.make(id),
            author: turnProvenance.author,
            lineage: turnProvenance.lineage,
            threadId,
            stopIntent: "none" as const,
            prompt: id,
            executionRoute: executionRoute(),
            status: "queued" as const,
            createdAt: index + 1,
            updatedAt: index + 1,
          }),
        ),
      )
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const failingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.as({
              turnId: input.turnId,
              status: input.turnId === "failing" ? ("failed" as const) : ("completed" as const),
              events: [],
            }),
          ),
      })
      yield* reconcile().pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, failingBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["failing"])
      expect((yield* turns.get(Turn.TurnId.make("later")))?.status).toBe("queued")
    }),
  )
})
