import type { InteractiveSession } from "@rika/product/interactive-session"
import { reconcile } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

import { queuedTurnPromoteMaxAgeMs } from "@rika/product/pending-turn"
import { createTurn, executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import {
  holdSession,
  openInteractiveSession,
  reconcileDependencies,
  unusedExtensions,
} from "../support/operation-session-harness"
import { backend } from "../support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("rejects secret-bearing config before execution_route_json persistence", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const turns = yield* TurnRepository.makeMemory([])
      const writes = yield* Ref.make(0)
      const repository = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(createTurn(turns, input))),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("must not persist")
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, repository),
            backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
            resolveExecutionRoute: () =>
              Effect.try(() => {
                SettingsDecoder.Decoder.decodeSettingsInput("settings.json", {
                  models: {
                    unsafe: {
                      ...SettingsDefaults.Defaults.defaults.models.luna,
                      variants: { low: { normal: { options: { nested: { signature: "secret" } } } } },
                    },
                  },
                })
                return Turn.testExecutionRoute("medium")
              }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-rejected-config")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("turn-rejected-config")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(writes)).toBe(0)
      expect(yield* turns.get(Turn.TurnId.make("turn-rejected-config"))).toBeUndefined()
    }),
  )

  it.effect("keeps one backend layer alive for sequential interactive submissions", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const acquisitions = yield* Ref.make(0)
      const turnIds = yield* Ref.make(0)
      const turns = yield* TurnRepository.makeMemory([])
      const backendLayer = Layer.effect(
        ExecutionBackend.Service,
        Ref.updateAndGet(acquisitions, (value) => value + 1).pipe(
          Effect.map((generation) =>
            ExecutionBackend.Service.of({
              ...backend,
              start: (input) =>
                Ref.update(starts, (values) => [...values, `${generation}:${input.prompt}`]).pipe(
                  Effect.andThen(backend.start(input)),
                ),
            }),
          ),
        ),
      )
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("First turn", "low")
        while ((yield* turns.get(Turn.TurnId.make("turn-1")))?.status !== "completed") yield* Effect.yieldNow
        yield* session.submit("Second turn", "ultra")
        while ((yield* turns.get(Turn.TurnId.make("turn-2")))?.status !== "completed") yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer,
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-sequential")),
            makeTurnId: Ref.updateAndGet(turnIds, (value) => value + 1).pipe(
              Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
            ),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(acquisitions)).toBe(1)
      expect((yield* Ref.get(starts)).filter((value) => !value.includes("Generate a concise"))).toEqual([
        "1:First turn",
        "1:Second turn",
      ])
      const firstTurn = yield* turns.get(Turn.TurnId.make("turn-1"))
      const secondTurn = yield* turns.get(Turn.TurnId.make("turn-2"))
      expect(
        firstTurn !== undefined && Turn.isAgentExecution(firstTurn) ? firstTurn.executionRoute.mode : undefined,
      ).toBe("low")
      expect(
        secondTurn !== undefined && Turn.isAgentExecution(secondTurn) ? secondTurn.executionRoute.mode : undefined,
      ).toBe("ultra")
      expect((yield* turns.get(Turn.TurnId.make("turn-2")))?.status).toBe("completed")
    }),
  )

  it.effect("re-prepares an accepted Turn once and starts with its pinned route", () =>
    Effect.gen(function* () {
      const pinnedRoute = {
        ...executionRoute(),
        main: { ...executionRoute().main, model: "pinned-recovery-model" },
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("turn-restart"),
          ...turnProvenance,
          threadId: Thread.ThreadId.make("thread-restart"),
          prompt: "resume",
          executionRoute: pinnedRoute,
          status: "accepted",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const preparations = yield* Ref.make(0)
      const restartBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, input]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* reconcile(unusedExtensions, (turn) =>
        Ref.update(preparations, (count) => count + 1).pipe(
          Effect.as({
            prompt: `${turn.prompt} with recomputed context`,
            promptParts: undefined,
            extensionPin: undefined,
          }),
        ),
      ).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer([selectionThread("thread-restart")]),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, restartBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toMatchObject([
        {
          threadId: "thread-restart",
          turnId: "turn-restart",
          prompt: "resume with recomputed context",
          executionRoute: { main: { model: "pinned-recovery-model" } },
        },
      ])
      expect(yield* Ref.get(preparations)).toBe(1)
      expect((yield* Ref.get(starts))[0]?.executionRoute).toEqual(pinnedRoute)
      expect((yield* turns.get(Turn.TurnId.make("turn-restart")))?.status).toBe("completed")
    }),
  )

  it.effect("does not start an accepted Turn when cancellation wins the durable claim", () =>
    Effect.gen(function* () {
      const thread = selectionThread("cancelled-restart-thread")
      const turn: Turn.Turn = {
        id: Turn.TurnId.make("cancelled-restart-turn"),
        ...turnProvenance,
        threadId: thread.id,
        prompt: "do not resume",
        executionRoute: executionRoute(),
        status: "accepted",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([turn])
      const claimEntered = yield* Deferred.make<void>()
      const releaseClaim = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        startAccepted: (id, now) =>
          Deferred.succeed(claimEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseClaim)),
            Effect.andThen(turns.startAccepted(id, now)),
          ),
      })
      const starts = yield* Ref.make(0)
      const restartBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      const repair = yield* Effect.forkChild(
        reconcile(unusedExtensions, (current) =>
          Effect.succeed({ prompt: current.prompt, promptParts: undefined, extensionPin: undefined }),
        ).pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer([thread]),
              Layer.succeed(TurnRepository.Service, delayedTurns),
              Layer.succeed(ExecutionBackend.Service, restartBackend),
            ),
          ),
        ),
      )

      yield* Deferred.await(claimEntered)
      expect(yield* turns.cancelAccepted(turn.id, 2)).toBe(true)
      yield* Deferred.succeed(releaseClaim, undefined)
      yield* Fiber.join(repair)

      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* turns.get(turn.id)).toMatchObject({ status: "cancelled", updatedAt: 2 })
    }),
  )

  it.effect("does not restart a turn dequeued after the reconcile scan", () =>
    Effect.gen(function* () {
      const turnId = Turn.TurnId.make("stale-reconcile-turn")
      const threadId = Thread.ThreadId.make("stale-reconcile-thread")
      const queued: Turn.Turn = {
        id: turnId,
        threadId,
        prompt: "do not restart",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([queued])
      const scanned = yield* Deferred.make<void>()
      const continueReconcile = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Deferred.succeed(scanned, undefined).pipe(
          Effect.andThen(Deferred.await(continueReconcile)),
          Effect.as([{ ...queued, status: "running" as const }]),
        ),
      })
      const starts = yield* Ref.make(0)
      const staleBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      const repair = yield* Effect.forkChild(
        reconcile().pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer(),
              Layer.succeed(TurnRepository.Service, delayedTurns),
              Layer.succeed(ExecutionBackend.Service, staleBackend),
            ),
          ),
        ),
      )

      yield* Deferred.await(scanned)
      yield* turns.dequeue(turnId)
      yield* Deferred.succeed(continueReconcile, undefined)
      yield* Fiber.join(repair)

      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* turns.get(turnId)).toBeUndefined()
    }),
  )

  it.effect("refuses to auto-promote queued turns older than the promotion window", () =>
    Effect.gen(function* () {
      const thread = selectionThread("stale-queue-thread")
      const active: Turn.Turn = {
        id: Turn.TurnId.make("stale-queue-active"),
        threadId: thread.id,
        prompt: "waiting",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "waiting",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const staleQueued: Turn.Turn = {
        id: Turn.TurnId.make("stale-queue-turn"),
        threadId: thread.id,
        prompt: "old queued prompt",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([active, staleQueued])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const recordingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, input.turnId]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* TestClock.adjust(`${queuedTurnPromoteMaxAgeMs + 1_000} millis`)
      yield* reconcile(undefined, () =>
        Effect.succeed({ prompt: staleQueued.prompt, promptParts: undefined, extensionPin: undefined }),
      ).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer([thread]),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, recordingBackend),
          ),
        ),
      )
      expect((yield* Ref.get(starts)).includes(String(staleQueued.id))).toBe(false)
      expect(yield* turns.get(staleQueued.id)).toMatchObject({ status: "queued" })
    }),
  )

  it.effect("releases an interrupted preparation claim without terminalizing the queued turn", () =>
    Effect.gen(function* () {
      const thread = selectionThread("interrupted-preparation-thread")
      const queued: Turn.Turn = {
        id: Turn.TurnId.make("interrupted-preparation-turn"),
        threadId: thread.id,
        prompt: "retry after interruption",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([queued])
      const preparationEntered = yield* Deferred.make<void>()
      const repair = yield* Effect.forkChild(
        reconcile(undefined, () =>
          Deferred.succeed(preparationEntered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer([thread]),
              Layer.succeed(TurnRepository.Service, turns),
              Layer.succeed(ExecutionBackend.Service, backend),
            ),
          ),
        ),
      )

      yield* Deferred.await(preparationEntered)
      yield* Fiber.interrupt(repair)

      expect(yield* turns.get(queued.id)).toMatchObject({ status: "queued" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 1, queuedCount: 1 })
      expect((yield* turns.claimNextQueued(thread.id, 2))?.turn.id).toBe(queued.id)
    }),
  )
})
