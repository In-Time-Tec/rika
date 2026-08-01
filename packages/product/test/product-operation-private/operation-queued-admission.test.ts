import { reconcile } from "../../src/operation/dispatch/product-operation-dispatch"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { Repositories } from "./operation-queued-admission-repositories"
import { Helpers } from "./operation-queued-admission-helpers"

describe("Operation", () => {
  it.effect("rejects secret-bearing config before execution_route_json persistence", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const turns = yield* Repositories.TurnRepository.makeMemory([])
      const writes = yield* Ref.make(0)
      const repository = Repositories.TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(Helpers.createTurn(turns, input))),
      })
      yield* Effect.gen(function* () {
        const session = yield* Helpers.openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("must not persist")
      }).pipe(
        Helpers.provideLayer(
          Helpers.productLayer({
            repositoryLayer: Repositories.ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(Repositories.TurnRepository.Service, repository),
            backendLayer: Layer.succeed(Repositories.ExecutionBackend.Service, Helpers.backend),
            resolveExecutionRoute: () =>
              Effect.try(() => {
                Repositories.SettingsDecoder.Decoder.decodeSettingsInput("settings.json", {
                  models: {
                    unsafe: {
                      ...SettingsDefaults.Defaults.defaults.models.luna,
                      variants: { low: { normal: { options: { nested: { signature: "secret" } } } } },
                    },
                  },
                })
                return Repositories.ExecutionRouteSnapshot.testExecutionRoute("medium")
              }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Repositories.Thread.ThreadId.make("thread-rejected-config")),
            makeTurnId: Effect.succeed(Repositories.Turn.TurnId.make("turn-rejected-config")),
            interactive: Helpers.holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(writes)).toBe(0)
      expect(yield* turns.get(Repositories.Turn.TurnId.make("turn-rejected-config"))).toBeUndefined()
    }),
  )

  it.effect("keeps one Helpers.backend layer alive for sequential interactive submissions", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const acquisitions = yield* Ref.make(0)
      const turnIds = yield* Ref.make(0)
      const turns = yield* Repositories.TurnRepository.makeMemory([])
      const backendLayer = Layer.effect(
        Repositories.ExecutionBackend.Service,
        Ref.updateAndGet(acquisitions, (value) => value + 1).pipe(
          Effect.map((generation) =>
            Repositories.ExecutionBackend.Service.of({
              ...Helpers.backend,
              start: (input) =>
                Ref.update(starts, (values) => [...values, `${generation}:${input.prompt}`]).pipe(
                  Effect.andThen(Helpers.backend.start(input)),
                ),
            }),
          ),
        ),
      )
      yield* Effect.gen(function* () {
        const session = yield* Helpers.openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("First turn", "low")
        while ((yield* turns.get(Repositories.Turn.TurnId.make("turn-1")))?.status !== "completed")
          yield* Effect.yieldNow
        yield* session.submit("Second turn", "ultra")
        while ((yield* turns.get(Repositories.Turn.TurnId.make("turn-2")))?.status !== "completed")
          yield* Effect.yieldNow
      }).pipe(
        Helpers.provideLayer(
          Helpers.productLayer({
            repositoryLayer: Repositories.ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(Repositories.TurnRepository.Service, turns),
            backendLayer,
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Repositories.Thread.ThreadId.make("thread-sequential")),
            makeTurnId: Ref.updateAndGet(turnIds, (value) => value + 1).pipe(
              Effect.map((value) => Repositories.Turn.TurnId.make(`turn-${value}`)),
            ),
            interactive: Helpers.holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(acquisitions)).toBe(1)
      expect((yield* Ref.get(starts)).filter((value) => !value.includes("Generate a concise"))).toEqual([
        "1:First turn",
        "1:Second turn",
      ])
      const firstTurn = yield* turns.get(Repositories.Turn.TurnId.make("turn-1"))
      const secondTurn = yield* turns.get(Repositories.Turn.TurnId.make("turn-2"))
      expect(
        firstTurn !== undefined && Repositories.ThreadResult.TurnResult.isAgentExecution(firstTurn)
          ? firstTurn.executionRoute.mode
          : undefined,
      ).toBe("low")
      expect(
        secondTurn !== undefined && Repositories.ThreadResult.TurnResult.isAgentExecution(secondTurn)
          ? secondTurn.executionRoute.mode
          : undefined,
      ).toBe("ultra")
      expect((yield* turns.get(Repositories.Turn.TurnId.make("turn-2")))?.status).toBe("completed")
    }),
  )

  it.effect("re-prepares an accepted Repositories.Turn once and starts with its pinned route", () =>
    Effect.gen(function* () {
      const pinnedRoute = {
        ...Helpers.executionRoute(),
        main: { ...Helpers.executionRoute().main, model: "pinned-recovery-model" },
      }
      const turns = yield* Repositories.TurnRepository.makeMemory([
        {
          id: Repositories.Turn.TurnId.make("turn-restart"),
          ...Helpers.turnProvenance,
          threadId: Repositories.Thread.ThreadId.make("thread-restart"),
          prompt: "resume",
          executionRoute: pinnedRoute,
          status: "accepted",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<Repositories.ExecutionBackend.StartInput>>([])
      const preparations = yield* Ref.make(0)
      const restartBackend = Repositories.ExecutionBackend.Service.of({
        ...Helpers.backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, input]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* reconcile(Helpers.unusedExtensions, (turn) =>
        Ref.update(preparations, (count) => count + 1).pipe(
          Effect.as({
            prompt: `${turn.prompt} with recomputed context`,
            promptParts: undefined,
            extensionPin: undefined,
          }),
        ),
      ).pipe(
        Helpers.provideLayer(
          Layer.mergeAll(
            Helpers.reconcileDependencies(Helpers.unusedExtensions),
            Repositories.ThreadRepository.memoryLayer([Helpers.selectionThread("thread-restart")]),
            Layer.succeed(Repositories.TurnRepository.Service, turns),
            Layer.succeed(Repositories.ExecutionBackend.Service, restartBackend),
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
      expect((yield* turns.get(Repositories.Turn.TurnId.make("turn-restart")))?.status).toBe("completed")
    }),
  )

  it.effect("does not start an accepted Repositories.Turn when cancellation wins the durable claim", () =>
    Effect.gen(function* () {
      const thread = Helpers.selectionThread("cancelled-restart-thread")
      const turn: Repositories.Turn.Turn = {
        id: Repositories.Turn.TurnId.make("cancelled-restart-turn"),
        ...Helpers.turnProvenance,
        threadId: thread.id,
        prompt: "do not resume",
        executionRoute: Helpers.executionRoute(),
        status: "accepted",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* Repositories.TurnRepository.makeMemory([turn])
      const claimEntered = yield* Deferred.make<void>()
      const releaseClaim = yield* Deferred.make<void>()
      const delayedTurns = Repositories.TurnRepository.Service.of({
        ...turns,
        startAccepted: (id, now) =>
          Deferred.succeed(claimEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseClaim)),
            Effect.andThen(turns.startAccepted(id, now)),
          ),
      })
      const starts = yield* Ref.make(0)
      const restartBackend = Repositories.ExecutionBackend.Service.of({
        ...Helpers.backend,
        start: (input) =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      const repair = yield* Effect.forkChild(
        reconcile(Helpers.unusedExtensions, (current) =>
          Effect.succeed({ prompt: current.prompt, promptParts: undefined, extensionPin: undefined }),
        ).pipe(
          Helpers.provideLayer(
            Layer.mergeAll(
              Helpers.reconcileDependencies(Helpers.unusedExtensions),
              Repositories.ThreadRepository.memoryLayer([thread]),
              Layer.succeed(Repositories.TurnRepository.Service, delayedTurns),
              Layer.succeed(Repositories.ExecutionBackend.Service, restartBackend),
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
      const turnId = Repositories.Turn.TurnId.make("stale-reconcile-turn")
      const threadId = Repositories.Thread.ThreadId.make("stale-reconcile-thread")
      const queued: Repositories.Turn.Turn = {
        id: turnId,
        threadId,
        prompt: "do not restart",
        ...Helpers.turnProvenance,
        executionRoute: Helpers.executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* Repositories.TurnRepository.makeMemory([queued])
      const scanned = yield* Deferred.make<void>()
      const continueReconcile = yield* Deferred.make<void>()
      const delayedTurns = Repositories.TurnRepository.Service.of({
        ...turns,
        listNonterminal: Deferred.succeed(scanned, undefined).pipe(
          Effect.andThen(Deferred.await(continueReconcile)),
          Effect.as([{ ...queued, status: "running" as const }]),
        ),
      })
      const starts = yield* Ref.make(0)
      const staleBackend = Repositories.ExecutionBackend.Service.of({
        ...Helpers.backend,
        start: (input) =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      const repair = yield* Effect.forkChild(
        reconcile().pipe(
          Helpers.provideLayer(
            Layer.mergeAll(
              Helpers.reconcileDependencies(Helpers.unusedExtensions),
              Repositories.ThreadRepository.memoryLayer(),
              Layer.succeed(Repositories.TurnRepository.Service, delayedTurns),
              Layer.succeed(Repositories.ExecutionBackend.Service, staleBackend),
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
      const thread = Helpers.selectionThread("stale-queue-thread")
      const active: Repositories.Turn.Turn = {
        id: Repositories.Turn.TurnId.make("stale-queue-active"),
        threadId: thread.id,
        prompt: "waiting",
        ...Helpers.turnProvenance,
        executionRoute: Helpers.executionRoute(),
        status: "waiting",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const staleQueued: Repositories.Turn.Turn = {
        id: Repositories.Turn.TurnId.make("stale-queue-turn"),
        threadId: thread.id,
        prompt: "old queued prompt",
        ...Helpers.turnProvenance,
        executionRoute: Helpers.executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* Repositories.TurnRepository.makeMemory([active, staleQueued])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const recordingBackend = Repositories.ExecutionBackend.Service.of({
        ...Helpers.backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, input.turnId]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* TestClock.adjust(`${Repositories.queuedTurnPromoteMaxAgeMs + 1_000} millis`)
      yield* reconcile(undefined, () =>
        Effect.succeed({ prompt: staleQueued.prompt, promptParts: undefined, extensionPin: undefined }),
      ).pipe(
        Helpers.provideLayer(
          Layer.mergeAll(
            Helpers.reconcileDependencies(Helpers.unusedExtensions),
            Repositories.ThreadRepository.memoryLayer([thread]),
            Layer.succeed(Repositories.TurnRepository.Service, turns),
            Layer.succeed(Repositories.ExecutionBackend.Service, recordingBackend),
          ),
        ),
      )
      expect((yield* Ref.get(starts)).includes(String(staleQueued.id))).toBe(false)
      expect(yield* turns.get(staleQueued.id)).toMatchObject({ status: "queued" })
    }),
  )

  it.effect("releases an interrupted preparation claim without terminalizing the queued turn", () =>
    Effect.gen(function* () {
      const thread = Helpers.selectionThread("interrupted-preparation-thread")
      const queued: Repositories.Turn.Turn = {
        id: Repositories.Turn.TurnId.make("interrupted-preparation-turn"),
        threadId: thread.id,
        prompt: "retry after interruption",
        ...Helpers.turnProvenance,
        executionRoute: Helpers.executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* Repositories.TurnRepository.makeMemory([queued])
      const preparationEntered = yield* Deferred.make<void>()
      const repair = yield* Effect.forkChild(
        reconcile(undefined, () =>
          Deferred.succeed(preparationEntered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(
          Helpers.provideLayer(
            Layer.mergeAll(
              Helpers.reconcileDependencies(Helpers.unusedExtensions),
              Repositories.ThreadRepository.memoryLayer([thread]),
              Layer.succeed(Repositories.TurnRepository.Service, turns),
              Layer.succeed(Repositories.ExecutionBackend.Service, Helpers.backend),
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
