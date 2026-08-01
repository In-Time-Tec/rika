import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { Operation, ResolvedContext } from "@rika/product/product-operation"
import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { collectEvents, holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend, inspectFromTurns } from "../support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("reprepares an edited promoted queued turn before starting it", () =>
    Effect.gen(function* () {
      const thread = selectionThread("edit-preparation-thread")
      const activeId = Turn.TurnId.make("edit-preparation-active")
      const queuedId = Turn.TurnId.make("edit-preparation-queued")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: queuedId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "original prompt",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events: Array<Operation.InteractiveEvent> = []
      const preparationEntered = yield* Deferred.make<void>()
      const releasePreparation = yield* Deferred.make<void>()
      const preparations = yield* Ref.make(0)
      const starts = yield* Ref.make<ReadonlyArray<{ readonly prompt: string; readonly status: string | undefined }>>(
        [],
      )
      const preparedBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: inspectFromTurns(turns),
        cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
        start: (input) =>
          Effect.gen(function* () {
            const persisted = yield* turns.get(Turn.TurnId.make(input.turnId)).pipe(Effect.orDie)
            yield* Ref.update(starts, (all) => [...all, { prompt: input.prompt, status: persisted?.status }])
            return yield* backend.start(input)
          }),
      })
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, preparedBackend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(preparations, (count) => count + 1)
              if (attempt === 1) {
                yield* Deferred.succeed(preparationEntered, undefined)
                yield* Deferred.await(releasePreparation)
              }
              return { sources: [], diagnostics: [], digest: "" }
            }),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
        yield* collectEvents(session, events)
        yield* session.selectThread(thread.id, 1)
        yield* Effect.forkChild(session.cancel)
        yield* Deferred.await(preparationEntered)
        yield* session.editQueued(queuedId, "edited prompt")
        yield* Deferred.succeed(releasePreparation, undefined)
        while ((yield* turns.get(queuedId))?.status !== "completed") yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(preparations)).toBe(2)
      expect(yield* Ref.get(starts)).toEqual([{ prompt: "edited prompt", status: "running" }])
      const queueEvents = events.filter((event) => event._tag === "QueueUpdated")
      expect(queueEvents.map((event) => [event.revision, event.queuedCount, event.change._tag])).toEqual([
        [2, 1, "Updated"],
        [3, 0, "Removed"],
      ])
      const started = events.filter((event) => event._tag === "TurnStarted")
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ turn: { id: queuedId, prompt: "edited prompt", status: "running" } })
    }),
  )

  it.effect("skips a dequeued promoted head and runs the next queued turn", () =>
    Effect.gen(function* () {
      const thread = selectionThread("dequeue-preparation-thread")
      const activeId = Turn.TurnId.make("dequeue-preparation-active")
      const headId = Turn.TurnId.make("dequeue-preparation-head")
      const nextId = Turn.TurnId.make("dequeue-preparation-next")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: headId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "head",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: nextId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "next",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events: Array<Operation.InteractiveEvent> = []
      const preparationEntered = yield* Deferred.make<void>()
      const releasePreparation = yield* Deferred.make<void>()
      const preparations = yield* Ref.make(0)
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const preparedBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: inspectFromTurns(turns),
        cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
        start: (input) =>
          Ref.update(starts, (all) => [...all, String(input.turnId)]).pipe(Effect.andThen(backend.start(input))),
      })
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, preparedBackend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(preparations, (count) => count + 1)
              if (attempt === 1) {
                yield* Deferred.succeed(preparationEntered, undefined)
                yield* Deferred.await(releasePreparation)
              }
              return { sources: [], diagnostics: [], digest: "" }
            }),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
        yield* collectEvents(session, events)
        yield* session.selectThread(thread.id, 1)
        yield* Effect.forkChild(session.cancel)
        yield* Deferred.await(preparationEntered)
        yield* session.dequeue(headId)
        yield* Deferred.succeed(releasePreparation, undefined)
        while ((yield* turns.get(nextId))?.status !== "completed") yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(preparations)).toBe(2)
      expect(yield* Ref.get(starts)).toEqual([nextId])
      expect(yield* turns.get(headId)).toBeUndefined()
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 4, queuedCount: 0, turns: [] })
      const queueEvents = events.filter((event) => event._tag === "QueueUpdated")
      expect(queueEvents.map((event) => [event.revision, event.queuedCount, event.change._tag])).toEqual([
        [3, 1, "Removed"],
        [4, 0, "Removed"],
      ])
      expect(events.filter((event) => event._tag === "TurnStarted").map((event) => event.turn.id)).toEqual([nextId])
      expect(events.some((event) => event._tag === "ExecutionFailed" && event.turnId === headId)).toBe(false)
    }),
  )

  it.effect("steers a claimed queued prompt before preparation makes it running", () =>
    Effect.gen(function* () {
      const thread = selectionThread("steer-race-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("steer-race-active"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("steer-race-queued"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "queued prompt",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const queuedRead = yield* Deferred.make<void>()
      const releaseQueuedRead = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        takeQueued: (id) =>
          id === "steer-race-queued"
            ? Deferred.succeed(queuedRead, undefined).pipe(
                Effect.andThen(Deferred.await(releaseQueuedRead)),
                Effect.andThen(turns.takeQueued(id)),
              )
            : turns.takeQueued(id),
      })
      const steers = yield* Ref.make<ReadonlyArray<string>>([])
      const raceBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        steer: (turnId, text) =>
          Ref.update(steers, (values) => [...values, text]).pipe(
            Effect.as({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.selectThread(thread.id, 1)
        const steering = yield* Effect.forkChild(session.steerQueued("steer-race-queued", "fallback"))
        yield* Deferred.await(queuedRead)
        yield* turns.setStatus(Turn.TurnId.make("steer-race-active"), "completed", undefined, 3)
        expect((yield* turns.claimNextQueued(thread.id, 4))?.turn.id).toBe("steer-race-queued")
        yield* Deferred.succeed(releaseQueuedRead, undefined)
        yield* Fiber.join(steering)
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, delayedTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, raceBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(steers)).toEqual(["queued prompt"])
      expect(yield* turns.get(Turn.TurnId.make("steer-race-queued"))).toBeUndefined()
    }),
  )
})
