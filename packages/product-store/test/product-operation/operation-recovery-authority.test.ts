import * as ExecutionStatus from "@rika/product/execution-status"
import { Service } from "@rika/product/product-operation-service"
import { hasActiveExecutionWork } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { AgentDepth } from "@rika/product/execution-service"
import { Effect, Layer, Ref } from "effect"

import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { backend } from "../support/operation-execution-fixtures"

import { selectionThread, replacementTurn } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("reconciles a stale nonterminal row from authoritative Relay state", () =>
    Effect.gen(function* () {
      for (const status of ["accepted", "running", "waiting"] as const) {
        const stale = replacementTurn(status)
        const turns = yield* TurnRepository.makeMemory([stale])
        const threads = yield* ThreadRepository.makeMemory([selectionThread(String(stale.threadId))])
        const result = yield* hasActiveExecutionWork().pipe(
          provideLayer(
            Layer.mergeAll(
              Layer.succeed(ThreadRepository.Service, threads),
              Layer.succeed(TurnRepository.Service, turns),
              Layer.succeed(ExecutionBackend.Service, {
                ...backend,
                inspect: () => Effect.void.pipe(Effect.as(undefined)),
              }),
            ),
          ),
        )
        expect(result).toBe(false)
        expect((yield* turns.get(stale.id))?.status).toBe("failed")
      }
    }),
  )

  it.effect("finds active work in a real recursively delegated Relay child tree", () =>
    Effect.gen(function* () {
      const turn = replacementTurn()
      const turns = yield* TurnRepository.makeMemory([turn])
      const threads = yield* ThreadRepository.makeMemory([selectionThread(String(turn.threadId))])
      const child = AgentDepth.childExecutionId(turn.id, "task")
      const grandchild = AgentDepth.childExecutionId(child, "oracle")
      const inspection = (turnId: string): ExecutionBackend.Inspection => {
        let children: ExecutionBackend.Inspection["children"] = []
        if (turnId === turn.id) children = [{ executionId: child, status: "completed" }]
        else if (turnId === child) children = [{ executionId: grandchild, status: "running" }]
        return { turnId, status: "completed", waits: [], pendingTools: [], children }
      }
      const result = yield* hasActiveExecutionWork().pipe(
        provideLayer(
          Layer.mergeAll(
            Layer.succeed(ThreadRepository.Service, threads),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(
              ExecutionBackend.Service,
              ExecutionBackend.Service.of({ ...backend, inspect: (turnId) => Effect.succeed(inspection(turnId)) }),
            ),
          ),
        ),
      )
      expect(result).toBe(true)
      expect((yield* turns.get(turn.id))?.status).toBe("running")
    }),
  )

  it.effect("defers replacement for active descendants beneath terminal roots", () =>
    Effect.gen(function* () {
      for (const status of ["completed", "failed", "cancelled"] as const) {
        const turn = replacementTurn(status)
        const turns = yield* TurnRepository.makeMemory([turn])
        const threads = yield* ThreadRepository.makeMemory([selectionThread(String(turn.threadId))])
        const child = AgentDepth.childExecutionId(turn.id, `terminal-${status}`)
        const childStatus = yield* Ref.make<ExecutionStatus.Status | "absent">("running")
        const inspectedBackend = ExecutionBackend.Service.of({
          ...backend,
          inspect: (turnId) =>
            Effect.gen(function* () {
              if (turnId === child) {
                const current = yield* Ref.get(childStatus)
                if (current === "absent") return undefined
                return { turnId, status: current, waits: [], pendingTools: [], children: [] }
              }
              const current = yield* Ref.get(childStatus)
              return {
                turnId,
                status,
                waits: [],
                pendingTools: [],
                children: [{ executionId: child, status: current === "running" ? "running" : "completed" }],
              }
            }),
        })
        const layer = Layer.mergeAll(
          Layer.succeed(ThreadRepository.Service, threads),
          Layer.succeed(TurnRepository.Service, turns),
          Layer.succeed(ExecutionBackend.Service, inspectedBackend),
        )

        expect(yield* hasActiveExecutionWork().pipe(provideLayer(layer))).toBe(true)
        yield* Ref.set(childStatus, "completed")
        expect(yield* hasActiveExecutionWork().pipe(provideLayer(layer))).toBe(false)
        yield* Ref.set(childStatus, "absent")
        expect(yield* hasActiveExecutionWork().pipe(provideLayer(layer))).toBe(false)
        expect((yield* turns.get(turn.id))?.status).toBe(status)
      }
    }),
  )

  it.effect("authorizes retry only after Relay work becomes terminal and fails closed on inspection errors", () =>
    Effect.gen(function* () {
      const turn = replacementTurn()
      const turns = yield* TurnRepository.makeMemory([turn])
      const threads = yield* ThreadRepository.makeMemory([selectionThread(String(turn.threadId))])
      const status = yield* Ref.make<ExecutionStatus.Status>("running")
      const inspectedBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Ref.get(status).pipe(
            Effect.map((current) => ({ turnId, status: current, waits: [], pendingTools: [], children: [] })),
          ),
      })
      const layer = Layer.mergeAll(
        Layer.succeed(ThreadRepository.Service, threads),
        Layer.succeed(TurnRepository.Service, turns),
        Layer.succeed(ExecutionBackend.Service, inspectedBackend),
      )
      expect(yield* hasActiveExecutionWork().pipe(provideLayer(layer))).toBe(true)
      yield* Ref.set(status, "completed")
      expect(yield* hasActiveExecutionWork().pipe(provideLayer(layer))).toBe(false)
      expect((yield* turns.get(turn.id))?.status).toBe("completed")

      const active = replacementTurn()
      const failingTurns = yield* TurnRepository.makeMemory([active])
      const failingThreads = yield* ThreadRepository.makeMemory([selectionThread(String(active.threadId))])
      const failed = yield* Effect.result(
        hasActiveExecutionWork().pipe(
          provideLayer(
            Layer.mergeAll(
              Layer.succeed(ThreadRepository.Service, failingThreads),
              Layer.succeed(TurnRepository.Service, failingTurns),
              Layer.succeed(
                ExecutionBackend.Service,
                ExecutionBackend.Service.of({
                  ...backend,
                  inspect: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "inspection failed" })),
                }),
              ),
            ),
          ),
        ),
      )
      expect(failed._tag).toBe("Failure")
      expect((yield* failingTurns.get(active.id))?.status).toBe("running")
    }),
  )

  it.effect("authorizes replacement when terminal Relay executions retain stale pending tool records", () =>
    Effect.gen(function* () {
      const turn = replacementTurn()
      const turns = yield* TurnRepository.makeMemory([turn])
      const threads = yield* ThreadRepository.makeMemory([selectionThread(String(turn.threadId))])
      const child = AgentDepth.childExecutionId(turn.id, "terminal-child")
      const staleTool = {
        callId: "stale-tool",
        name: "task",
        input: {},
        requestedAt: 1,
      }
      const inspectedBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed({
            turnId,
            status: "completed" as const,
            waits: [],
            pendingTools: [staleTool],
            children: turnId === turn.id ? [{ executionId: child, status: "completed" as const }] : [],
          }),
      })
      const result = yield* hasActiveExecutionWork().pipe(
        provideLayer(
          Layer.mergeAll(
            Layer.succeed(ThreadRepository.Service, threads),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, inspectedBackend),
          ),
        ),
      )
      expect(result).toBe(false)
      expect((yield* turns.get(turn.id))?.status).toBe("completed")
    }),
  )

  it.effect(
    "authorizes replacement after a terminal child is pruned and retries after descendant inspection errors",
    () =>
      Effect.gen(function* () {
        const turn = replacementTurn()
        const child = AgentDepth.childExecutionId(turn.id, "terminal-child")
        const turns = yield* TurnRepository.makeMemory([turn])
        const childInspection = yield* Ref.make<"error" | "absent">("error")
        const inspectedBackend = ExecutionBackend.Service.of({
          ...backend,
          inspect: (turnId) =>
            Effect.gen(function* () {
              if (turnId === child) {
                if ((yield* Ref.get(childInspection)) === "error")
                  return yield* ExecutionBackend.BackendError.make({ message: "child inspection failed" })
                return undefined
              }
              return {
                turnId,
                status: "completed" as const,
                waits: [],
                pendingTools: [],
                children: [{ executionId: child, status: "completed" as const }],
              }
            }),
        })
        const layer = productLayer({
          repositoryLayer: ThreadRepository.memoryLayer([selectionThread(String(turn.threadId))]),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, inspectedBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Service
          const failed = yield* Effect.result(operation.authorizeResidentReplacement!)
          expect(failed._tag).toBe("Failure")
          expect((yield* turns.get(turn.id))?.status).toBe("running")

          yield* Ref.set(childInspection, "absent")
          expect(yield* operation.authorizeResidentReplacement!).toBe("supersede")
          expect((yield* turns.get(turn.id))?.status).toBe("completed")
        }).pipe(provideLayer(layer))
      }),
  )
})
