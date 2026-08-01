import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect, Layer, Ref } from "effect"

import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend, inspectFromTurns } from "../support/operation-execution-fixtures"
import { turnProvenance, threadLineage } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("exercises every interactive session control and its safe failure path", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer([
          {
            id: Turn.TurnId.make("orphan"),
            ...turnProvenance,
            threadId: Thread.ThreadId.make("orphan-thread"),
            prompt: "queued",
            executionRoute: executionRoute(),
            status: "queued",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.shell(undefined, "pwd", false)
        yield* session.editQueued("orphan", "changed")
        yield* session.dequeue("missing")
        yield* session.steer("direction")
        yield* session.interruptAndSend("next")
        yield* session.cancel
        yield* session.selectThread("missing", 1)
        yield* session.reopenThread(2)
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      expect((yield* Ref.get(events)).filter((event) => event._tag === "ExecutionFailed").length).toBeGreaterThan(0)
      expect(yield* Ref.get(events)).toContainEqual(
        expect.objectContaining({
          _tag: "ExecutionFailed",
          message: expect.stringContaining("Thread missing does not exist"),
        }),
      )
    }),
  )

  it.effect("admits 100 queued turns with constant-size deltas and no per-submit host wake", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const wakes = yield* Ref.make<ReadonlyArray<ExecutionBackend.ThreadQueueWake>>([])
      const promoters = yield* Ref.make<ReadonlyArray<ExecutionBackend.TurnPromoter>>([])
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const turnSequence = yield* Ref.make(0)
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("hosted"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Hosted",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const hostedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(started, (all) => [...all, input.turnId]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
        inspect: (turnId) =>
          Effect.succeed(
            turnId === "busy"
              ? {
                  turnId,
                  status: "running" as const,
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined,
          ),
        wakeThreadHost: (wake) => Ref.update(wakes, (all) => [...all, wake]),
        registerTurnPromoter: (promoter) => Ref.update(promoters, (all) => [...all, promoter]),
      })
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("busy"),
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
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, hostedBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 128,
        makeThreadId: Effect.succeed(thread.id),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`queued-turn-${value}`)),
        ),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.selectThread("hosted", 1)
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) => session.submit(`while busy ${index}`),
          { concurrency: "unbounded", discard: true },
        )
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(started)).toEqual([])
      expect(yield* Ref.get(wakes)).toEqual([])
      expect((yield* Ref.get(promoters)).length).toBeGreaterThan(0)
      expect((yield* Ref.get(events)).filter((event) => event._tag === "QueueUpdated")).toHaveLength(100)
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 100, queuedCount: 100 })
      const promoter = (yield* Ref.get(promoters))[0]
      if (promoter === undefined) return yield* Effect.die("missing promoter")
      expect(yield* promoter("missing-thread", 1)).toBe(0)
    }),
  )

  it.effect("dispatches successful interactive queue and control callbacks", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interactive-controls"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Controls",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active-control"),
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
          id: Turn.TurnId.make("queued-control"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "queued",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("queued-control-2"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "queued second",
          executionRoute: executionRoute(),
          status: "queued",
          stopIntent: "none",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (current) => [...current, event]))
      const controlBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: inspectFromTurns(turns),
        cancel: (turnId) =>
          Effect.succeed({
            turnId,
            status: "cancelled",
            stopIntent: "none",
            events: [
              executionStarted(String(turnId)),
              {
                executionId: String(turnId),
                cursor: "cancelled",
                sequence: 1,
                type: "execution.cancelled",
                timestampSource: "server",
                createdAt: 3,
              },
            ],
          }),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.selectThread(thread.id, 1)
        yield* session.editQueued("queued-control", "edited")
        yield* session.dequeue("queued-control")
        yield* session.submit("later")
        yield* session.steerQueued("queued-control-2", "redirect")
        yield* session.cancel
        yield* session.reopenThread(2)
        yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, controlBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("submitted-control")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      const dispatched = yield* Ref.get(events)
      expect(dispatched.some((event) => event._tag === "SelectionLoaded")).toBe(true)
      expect(dispatched.some((event) => event._tag === "QueueUpdated")).toBe(true)
      expect(
        dispatched
          .filter((event) => event._tag === "ExecutionControlled")
          .map((event) => (event._tag === "ExecutionControlled" ? event.action : undefined)),
      ).toEqual(["steered", "cancelled"])
      expect(dispatched.some((event) => event._tag === "TranscriptProjectionPatched")).toBe(true)
      expect(yield* turns.get(Turn.TurnId.make("active-control"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancelled",
      })
      expect(yield* turns.get(Turn.TurnId.make("queued-control-2"))).toBeUndefined()
      expect(yield* turns.get(Turn.TurnId.make("submitted-control"))).toMatchObject({ status: "completed" })
    }),
  )
})
