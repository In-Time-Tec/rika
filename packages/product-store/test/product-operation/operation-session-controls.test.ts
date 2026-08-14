import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import { executionRoute } from "../support/product-test-current-state"
import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend, projectionPatch, projectionSnapshot } from "../support/operation-execution-fixtures"
import { turnProvenance, threadLineage } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("exercises every interactive session control and its safe failure path", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer([
          {
            id: Turn.TurnId.make("orphan"),
            ...turnProvenance,
            threadId: Thread.ThreadId.make("orphan-thread"),
            prompt: "queued",
            executionRoute: executionRoute(),
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
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
        yield* session.steer("direction", "request-direction")
        yield* session.interruptAndSend("next")
        yield* session.cancel
        yield* session.selectThread("missing")
        yield* session.reopenThread
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      expect((yield* Ref.get(events)).filter((event) => event._tag === "ExecutionFailed").length).toBeGreaterThan(0)
      expect(yield* Ref.get(events)).toContainEqual(
        expect.objectContaining({
          _tag: "ExecutionFailed",
          failure: expect.objectContaining({ message: expect.stringContaining("Thread missing does not exist") }),
        }),
      )
      expect(yield* Ref.get(events)).toContainEqual(
        expect.objectContaining({
          _tag: "ExecutionControlFailed",
          action: "steer",
          steeringRequestId: "request-direction",
        }),
      )
    }),
  )

  it.effect("attributes an active interrupt to the user and shutdown cancellation to the server", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interrupt-attribution"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Interrupt attribution",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active-interrupt"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: {
            runId: "active-interrupt-run",
            turnId: "active-interrupt",
            threadId: String(thread.id),
          },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const cancellationReasons = yield* Ref.make<ReadonlyArray<string>>([])
      const interruptBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: () => Effect.succeed({ status: "running", cursor: "synthetic-running-cursor" }),
        watchTurn: () => Stream.never,
        cancelTurn: (_link, reason) => Ref.update(cancellationReasons, (reasons) => [...reasons, reason]),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.selectThread(thread.id)
        yield* session.interruptAndSend("replacement")
        yield* session.quit
      }).pipe(
        provideLayer(
          productLayer({
            executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, interruptBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("replacement-turn")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(cancellationReasons)).toEqual(["Cancelled by user", "Cancelled: server shutdown"])
    }),
  )

  it.effect("admits 100 queued turns with constant-size FIFO deltas while the server observes active work", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
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
      const hostedBackend = ExecutionGateway.Service.of({
        ...backend,
        startTurn: (input) =>
          Ref.update(started, (all) => [...all, input.turnId]).pipe(
            Effect.as({ runId: "hosted-queue-run", turnId: input.turnId, threadId: input.threadId }),
          ),
        watchTurn: () => Stream.never,
        inspectTurn: (link) =>
          Effect.succeed(
            link.turnId === "busy"
              ? ({ status: "running", cursor: "busy-running-cursor" } as const)
              : ({ status: "unavailable" } as const),
          ),
      })
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("busy"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: { runId: "busy-run", turnId: "busy", threadId: String(thread.id) },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, hostedBackend),
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
        yield* session.selectThread("hosted")
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) => session.submit(`while busy ${index}`),
          { concurrency: "unbounded", discard: true },
        )
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(started)).toEqual([])
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 100, queuedCount: 100 })
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
          executionLink: {
            runId: "active-control-run",
            turnId: "active-control",
            threadId: String(thread.id),
          },
          status: "running",
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
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const activeCancelled = yield* Deferred.make<void>()
      const firstSteeringAttempt = yield* Deferred.make<void>()
      const secondSteeringAttempt = yield* Deferred.make<void>()
      const cancellationReasons = yield* Ref.make<ReadonlyArray<string>>([])
      let steeringAttempts = 0
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (current) => [...current, event]))
      const controlBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: (link) =>
          link.turnId === "active-control"
            ? Deferred.isDone(activeCancelled).pipe(
                Effect.map((done) => ({
                  status: done ? ("cancelled" as const) : ("running" as const),
                  cursor: done ? "active-control-cancelled" : "active-control-started",
                })),
              )
            : Effect.succeed({ status: "completed", cursor: "cursor-b" }),
        watchTurn: (link, cursor) =>
          link.turnId === "active-control"
            ? Stream.concat(
                Stream.make(projectionSnapshot(link.turnId, "running", "active-control-started")),
                Stream.fromEffect(Deferred.await(activeCancelled)).pipe(
                  Stream.map(() => projectionPatch(0, 1, "cancelled", "active-control-cancelled")),
                ),
              )
            : backend.watchTurn(link, cursor),
        cancelTurn: (_link, reason) =>
          Ref.update(cancellationReasons, (reasons) => [...reasons, reason]).pipe(
            Effect.andThen(Deferred.succeed(activeCancelled, undefined)),
          ),
        steerTurn: () =>
          Effect.gen(function* () {
            steeringAttempts += 1
            if (steeringAttempts === 1) yield* Deferred.succeed(firstSteeringAttempt, undefined)
            if (steeringAttempts === 2) yield* Deferred.succeed(secondSteeringAttempt, undefined)
            return steeringAttempts < 3
              ? yield* ExecutionGateway.SteeringFailure.make({ kind: "unknown", message: "connection lost" })
              : { entryId: "accepted-steering", sequence: 0 }
          }),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* settleEvents
        yield* session.selectThread(thread.id)
        yield* session.editQueued("queued-control", "edited")
        yield* session.dequeue("queued-control")
        yield* session.submit("later")
        yield* session.steerQueued("queued-control-2", "redirect", "request-redirect")
        yield* Deferred.await(firstSteeringAttempt)
        yield* TestClock.adjust("100 millis")
        yield* Deferred.await(secondSteeringAttempt)
        yield* TestClock.adjust("200 millis")
        while ((yield* turns.listSteeringAdmissions).some((admission) => admission.outcome._tag === "Pending"))
          yield* Effect.yieldNow
        yield* session.cancel
        while ((yield* turns.get(Turn.TurnId.make("submitted-control")))?.status !== "completed") yield* Effect.yieldNow
        yield* session.reopenThread
        yield* settleEvents
      }).pipe(
        provideLayer(
          productLayer({
            executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
            repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, controlBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("submitted-control")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      const dispatched = yield* Ref.get(events)
      expect(dispatched.some((event) => event._tag === "ThreadViewSnapshot")).toBe(true)
      expect(
        dispatched
          .filter((event) => event._tag === "ExecutionControlled")
          .map((event) => (event._tag === "ExecutionControlled" ? event.action : undefined)),
      ).toEqual(["cancelled"])
      expect(steeringAttempts).toBe(3)
      expect(yield* Ref.get(cancellationReasons)).toEqual(["Cancelled by user"])
      expect(yield* turns.get(Turn.TurnId.make("active-control"))).toMatchObject({
        status: "cancelled",
      })
      expect(yield* turns.get(Turn.TurnId.make("queued-control-2"))).toBeUndefined()
      expect(yield* turns.get(Turn.TurnId.make("submitted-control"))).toMatchObject({ status: "completed" })
    }),
  )

  it.effect("promotes a queued turn restored after steering rejection and the final drain", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("restored-steering"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Restored steering",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const activeId = Turn.TurnId.make("restored-active")
      const queuedId = Turn.TurnId.make("restored-queued")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: { runId: "restored-run", turnId: activeId, threadId: thread.id },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: queuedId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "restore and promote",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const steeringAttempted = yield* Deferred.make<void>()
      const rejectSteering = yield* Deferred.make<void>()
      const activeCompleted = yield* Deferred.make<void>()
      const promoted = yield* Deferred.make<void>()
      const promotedCancelled = yield* Deferred.make<void>()
      const restoredBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: (link) =>
          link.turnId === activeId
            ? Deferred.isDone(activeCompleted).pipe(
                Effect.map((done) => ({
                  status: done ? ("completed" as const) : ("running" as const),
                  cursor: done ? "active-completed" : "active-running",
                })),
              )
            : Deferred.isDone(promotedCancelled).pipe(
                Effect.map((done) => ({
                  status: done ? ("cancelled" as const) : ("running" as const),
                  cursor: done ? "promoted-cancelled" : "promoted-running",
                })),
              ),
        watchTurn: (link) =>
          Stream.fromEffect(Deferred.await(promotedCancelled)).pipe(
            Stream.map(() => projectionSnapshot(link.turnId, "cancelled", "promoted-cancelled")),
          ),
        cancelTurn: () => Deferred.succeed(promotedCancelled, undefined),
        steerTurn: () =>
          Deferred.succeed(steeringAttempted, undefined).pipe(
            Effect.andThen(Deferred.await(rejectSteering)),
            Effect.andThen(ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "turn settled" })),
          ),
        startTurn: (input) =>
          Deferred.succeed(promoted, undefined).pipe(
            Effect.as({ runId: "promoted-run", turnId: input.turnId, threadId: input.threadId }),
          ),
      })
      const scenario = Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* settleEvents
        yield* session.selectThread(thread.id)
        yield* session.steerQueued(queuedId, "restore and promote", "restore-request")
        expect(yield* turns.listSteeringAdmissions).toMatchObject([
          { input: { idempotencyKey: "restore-request" }, outcome: { _tag: "Pending" } },
        ])
        yield* settleEvents
        expect(yield* Deferred.isDone(steeringAttempted)).toBe(true)
        yield* Deferred.succeed(activeCompleted, undefined)
        yield* turns.setStatus(activeId, "completed", 3)
        yield* Deferred.succeed(rejectSteering, undefined)
        yield* settleEvents
        expect(yield* Deferred.isDone(promoted)).toBe(true)
        yield* TestClock.adjust("100 millis")
        while ((yield* turns.listSteeringAdmissions).length > 0) yield* Effect.yieldNow
        expect(yield* turns.get(queuedId)).toMatchObject({ status: "running" })
        expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 0 })
        yield* session.quit
      }).pipe(
        provideLayer(
          productLayer({
            executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, restoredBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      yield* scenario
      expect(yield* turns.listSteeringAdmissions).toEqual([])
    }),
  )

  it.effect("reconciles terminal steering disposition without waiting for the retry timer", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("terminal-steering"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Terminal steering",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const activeId = Turn.TurnId.make("terminal-steering-active")
      const steeringId = Turn.TurnId.make("terminal-steering-source")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: { runId: "terminal-steering-run", turnId: activeId, threadId: thread.id },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: steeringId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "steering source",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const activeTerminal = yield* Deferred.make<void>()
      const steeringAccepted = yield* Deferred.make<void>()
      const receipt = { entryId: "terminal-steering-entry", sequence: 0 }
      const terminal = projectionSnapshot(activeId, "completed", "terminal-steering-completed")
      const terminalProjection = {
        ...terminal,
        state: {
          ...terminal.state,
          steering: {
            steeringMessages: 0,
            followUpMessages: 0,
            settled: [
              {
                runId: "terminal-steering-run",
                entryId: receipt.entryId,
                requestId: "terminal-steering-request",
                sequence: receipt.sequence,
                outcome: "discarded" as const,
              },
            ],
          },
        },
      }
      const terminalBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: () =>
          Deferred.isDone(activeTerminal).pipe(
            Effect.map((done) => ({
              status: done ? ("completed" as const) : ("running" as const),
              cursor: done ? "terminal-steering-completed" : "terminal-steering-running",
            })),
          ),
        steerTurn: () => Deferred.succeed(steeringAccepted, undefined).pipe(Effect.as(receipt)),
        watchTurn: () => Stream.fromEffect(Deferred.await(activeTerminal)).pipe(Stream.map(() => terminalProjection)),
      })
      const scenario = Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(() => {}))
        yield* settleEvents
        yield* session.selectThread(thread.id)
        yield* session.steerQueued(steeringId, "steering source", "terminal-steering-request")
        yield* Deferred.await(steeringAccepted)
        while ((yield* turns.listSteeringAdmissions).length > 0) yield* Effect.yieldNow

        yield* Deferred.succeed(activeTerminal, undefined)
        while ((yield* turns.get(activeId))?.status !== "completed") yield* Effect.yieldNow
        yield* settleEvents

        expect(yield* turns.get(steeringId)).toBeUndefined()
        expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 0, turns: [] })
        expect(yield* turns.listSteeringAdmissions).toEqual([])
        yield* session.quit
      }).pipe(
        provideLayer(
          productLayer({
            executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, terminalBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      yield* scenario
    }),
  )

  it.effect("replays terminal execution history before settling a recovered steering target", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("recovered-terminal-steering"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Recovered terminal steering",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const activeId = Turn.TurnId.make("recovered-terminal-active")
      const steeringId = Turn.TurnId.make("recovered-terminal-source")
      const target = { runId: "recovered-terminal-run", turnId: activeId, threadId: thread.id }
      const request = { text: "recovered steering", idempotencyKey: "recovered-terminal-request" }
      const receipt = { entryId: "recovered-terminal-entry", sequence: 0 }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: target,
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: steeringId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: request.text,
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      yield* turns.prepareQueuedSteeringAdmission(steeringId, target, request, [], 3)
      yield* turns.acceptSteeringAdmission(request.idempotencyKey, receipt)
      yield* turns.setStatus(activeId, "completed", 4)
      const terminal = projectionSnapshot(activeId, "completed", "recovered-terminal-completed")
      const terminalProjection = {
        ...terminal,
        state: {
          ...terminal.state,
          steering: {
            steeringMessages: 0,
            followUpMessages: 0,
            settled: [
              {
                runId: target.runId,
                entryId: receipt.entryId,
                requestId: request.idempotencyKey,
                sequence: receipt.sequence,
                outcome: "discarded" as const,
              },
            ],
          },
        },
      }
      const watched = yield* Deferred.make<void>()
      const recoveredBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "recovered-terminal-completed" }),
        watchTurn: () =>
          Stream.fromEffect(Deferred.succeed(watched, undefined)).pipe(
            Stream.flatMap(() => Stream.succeed(terminalProjection)),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const scenario = Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(() => {}))
        yield* settleEvents

        expect(yield* Deferred.isDone(watched)).toBe(true)
        while ((yield* turns.listSteeringAdmissions).length > 0) yield* Effect.yieldNow
        expect(yield* turns.get(activeId)).toMatchObject({ status: "completed" })
        expect(yield* turns.get(steeringId)).toBeUndefined()
        expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 0, turns: [] })
        yield* session.quit
      }).pipe(
        provideLayer(
          productLayer({
            executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, recoveredBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      yield* scenario
    }),
  )
})
