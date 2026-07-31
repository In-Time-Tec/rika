import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "@rika/product/product-operation"
import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import {
  collectEvents,
  holdSession,
  openInteractiveSession,
  settleEvents,
  nonActivation,
} from "../support/operation-session-harness"
import { backend, inspectFromTurns } from "../support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("fails a submission loudly when the session owner rejects the start", () =>
    Effect.gen(function* () {
      const thread = selectionThread("owned-session-thread")
      const turns = yield* TurnRepository.makeMemory()
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const ownerBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: inspectFromTurns(turns),
        start: (input) =>
          Ref.update(starts, (all) => [...all, String(input.turnId)]).pipe(
            Effect.andThen(
              ExecutionBackend.BackendError.make({
                message: `Session session:${input.turnId} is owned by execution execution:old at epoch 2`,
              }),
            ),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events: Array<Operation.InteractiveEvent> = []
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const eventsFiber = yield* collectEvents(session, events)
        yield* session.reopenThread(1)
        const submitted = yield* Effect.forkChild(session.submit("hello"))
        yield* Fiber.join(submitted)
        yield* settleEvents
        yield* Fiber.interrupt(eventsFiber)
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, ownerBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("submitted")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* turns.get(Turn.TurnId.make("submitted"))).toMatchObject({ status: "failed" })
      expect(yield* Ref.get(starts)).toEqual(["submitted"])
      expect(nonActivation(events).filter((event) => event._tag === "ExecutionFailed").length).toBeGreaterThan(0)
    }),
  )

  it.effect("requeues a direct submission while a cancelled predecessor is still releasing", () =>
    Effect.gen(function* () {
      const thread = selectionThread("blocked-submit-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("stale"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "stale",
          executionRoute: executionRoute(),
          status: "cancelled",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const cancelledExecutions = yield* Ref.make<ReadonlyArray<string>>([])
      const childId = "child:stale:worker"
      const gateBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId, reference) =>
          Effect.gen(function* () {
            if (reference !== undefined)
              return { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] }
            const turn = yield* turns.get(Turn.TurnId.make(turnId)).pipe(Effect.orDie)
            if (turn === undefined) return undefined
            return {
              turnId,
              status: turn.status,
              waits: [],
              pendingTools: [],
              children: turnId === "stale" ? [{ executionId: childId, status: "running" as const }] : [],
            }
          }),
        cancel: (turnId) =>
          Ref.update(cancelledExecutions, (all) => [...all, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
        start: (input) =>
          Ref.update(starts, (all) => [...all, String(input.turnId)]).pipe(Effect.andThen(backend.start(input))),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.reopenThread(1)
        const submitted = yield* Effect.forkChild(session.submit("fresh"))
        for (let index = 0; index < 40; index += 1) yield* Effect.yieldNow
        expect(yield* Ref.get(starts)).toEqual([])
        expect(yield* Ref.get(cancelledExecutions)).toEqual([])
        yield* TestClock.adjust("30 seconds")
        yield* Fiber.join(submitted)
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, gateBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("fresh")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual([])
      expect(yield* turns.get(Turn.TurnId.make("fresh"))).toMatchObject({ status: "queued" })
    }),
  )

  it.effect("executes interrupt-and-send when terminal admission races pending creation", () =>
    Effect.gen(function* () {
      const thread = selectionThread("interrupt-race-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("interrupt-race-active"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const racingTurns = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          turns
            .setStatus(Turn.TurnId.make("interrupt-race-active"), "completed", undefined, input.now)
            .pipe(Effect.andThen(turns.createForSubmission(input))),
      })
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const raceBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed(
            turnId === "interrupt-race-active"
              ? { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] }
              : undefined,
          ),
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(Effect.andThen(backend.start(input))),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.selectThread(thread.id, 1)
        yield* session.interruptAndSend("replacement")
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, racingTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, raceBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("interrupt-race-pending")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["interrupt-race-pending"])
      expect(yield* turns.get(Turn.TurnId.make("interrupt-race-pending"))).toMatchObject({ status: "completed" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 0, turns: [] })
    }),
  )

  it.effect("releases a defensive observer collision without terminalizing the queued turn", () =>
    Effect.gen(function* () {
      const thread = selectionThread("observer-collision-thread")
      const active: Turn.Turn = {
        id: Turn.TurnId.make("observer-collision-active"),
        threadId: thread.id,
        prompt: "active",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "running",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const queued: Turn.Turn = {
        id: Turn.TurnId.make("observer-collision-queued"),
        threadId: thread.id,
        prompt: "queued",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "queued",
        stopIntent: "none",
        createdAt: 2,
        updatedAt: 2,
      }
      const turns = yield* TurnRepository.makeMemory([active, queued])
      const collisionTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Effect.succeed([active, { ...queued, status: "running" as const }]),
        get: (id) =>
          turns
            .get(id)
            .pipe(
              Effect.map((turn) =>
                id === queued.id && turn !== undefined ? { ...turn, status: "running" as const } : turn,
              ),
            ),
      })
      const observerClaimed = yield* Deferred.make<void>()
      const collisionBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: inspectFromTurns(collisionTurns),
        follow: (turnId) =>
          (turnId === queued.id ? Deferred.succeed(observerClaimed, undefined) : Effect.void).pipe(
            Effect.andThen(Effect.never),
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
        yield* Deferred.await(observerClaimed)
        yield* session.cancel
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, collisionTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, collisionBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* turns.get(queued.id)).toMatchObject({ status: "queued" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 1, turns: [{ id: queued.id }] })
    }),
  )
})
