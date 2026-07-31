import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "@rika/product/product-operation"
import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { collectEvents, holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend, inspectFromTurns } from "../support/operation-execution-fixtures"
import { turnProvenance, threadLineage, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("restores a queued prompt when steering the active turn fails", () =>
    Effect.gen(function* () {
      const thread = selectionThread("steer-failure-thread")
      const queuedId = Turn.TurnId.make("steer-failure-queued")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("steer-failure-active"),
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
          prompt: "keep this prompt",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("steer-failure-later"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "later prompt",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const failingBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        steer: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "forced steer failure" })),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const received: Array<Operation.InteractiveEvent> = []

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* collectEvents(session, received)
        yield* session.selectThread(thread.id, 1)
        received.length = 0
        yield* session.steerQueued(queuedId, "unused fallback")
        yield* settleEvents
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, failingBackend),
            defaultWorkspace: "/work",
            pendingTurnCapacity: 2,
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )

      expect(yield* turns.get(queuedId)).toMatchObject({ status: "queued", prompt: "keep this prompt", createdAt: 2 })
      expect((yield* turns.readQueue(thread.id)).turns.map((turn) => turn.id)).toEqual([
        "steer-failure-queued",
        "steer-failure-later",
      ])
      expect(received).toContainEqual(
        expect.objectContaining({
          _tag: "ExecutionControlFailed",
          message: "Rika could not complete that action. Run rika diagnostics status if it keeps happening.",
        }),
      )
      expect(received.some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("interrupts an active turn and starts the replacement callback", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interrupt-thread"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Interrupt",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active"),
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
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (all) => [...all, event]))))
        yield* Effect.yieldNow
        yield* session.reopenThread(1)
        yield* session.interruptAndSend("replacement prompt")
        yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: inspectFromTurns(turns),
            }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("replacement")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({ status: "cancelled" })
      expect(yield* turns.get(Turn.TurnId.make("replacement"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("QueueUpdated")
    }),
  )

  it.effect("holds a replacement queued until the cancelled execution tree quiesces", () =>
    Effect.gen(function* () {
      const thread = selectionThread("quiescence-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active"),
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
      const childLive = yield* Ref.make(true)
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const cancelledExecutions = yield* Ref.make<ReadonlyArray<string>>([])
      const childId = "child:active:worker"
      const gateBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId, reference) =>
          Effect.gen(function* () {
            const live = yield* Ref.get(childLive)
            const childStatus = live ? ("running" as const) : ("cancelled" as const)
            if (reference !== undefined)
              return { turnId, status: childStatus, waits: [], pendingTools: [], children: [] }
            const turn = yield* turns.get(Turn.TurnId.make(turnId)).pipe(Effect.orDie)
            if (turn === undefined) return undefined
            return {
              turnId,
              status: turn.status,
              waits: [],
              pendingTools: [],
              children: turnId === "active" ? [{ executionId: childId, status: childStatus }] : [],
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
        const interrupted = yield* Effect.forkChild(session.interruptAndSend("replacement prompt"))
        for (let index = 0; index < 40; index += 1) yield* Effect.yieldNow
        expect(yield* Ref.get(starts)).toEqual([])
        expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({ status: "cancelled" })
        expect(yield* turns.get(Turn.TurnId.make("replacement"))).toMatchObject({ status: "queued" })
        expect(yield* Ref.get(cancelledExecutions)).toEqual(["active"])
        yield* Ref.set(childLive, false)
        yield* TestClock.adjust("250 millis")
        yield* Fiber.join(interrupted)
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, gateBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("replacement")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["replacement"])
      expect(yield* turns.get(Turn.TurnId.make("replacement"))).toMatchObject({ status: "completed" })
    }),
  )
})
