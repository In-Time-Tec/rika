import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { OperationUnavailable } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Deferred, Effect, Fiber, Layer, Ref, Scheduler } from "effect"

import { productLayer, provideLayer } from "../support/operation-layer-harness"
import {
  collectEvents,
  holdSession,
  openInteractiveSession,
  settleEvents,
  settleUsage,
} from "../support/operation-session-harness"
import { backend } from "../support/operation-execution-fixtures"

import { selectionThread } from "../support/operation-selection-fixtures"
import { makeSelectionLoadHarness } from "../support/operation-selection-harness"

describe("Operation", () => {
  it.effect("restores the selected feed after the thread repository fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(1)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.previous.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)
        yield* settleEvents
        received.length = 0

        yield* harness.failTargetGet
        yield* selecting.selectThread(harness.target.id, 2)
        yield* source.submit("stream after failed selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* settleEvents

        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "TranscriptProjectionPatched",
            selectionEpoch: 1,
            threadId: harness.previous.id,
            origin: expect.objectContaining({
              _tag: "Event",
              executionId: "selection-live-turn",
            }),
            delta: expect.objectContaining({ upsert: expect.any(Array), remove: expect.any(Array) }),
          }),
        )
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("restores the selected feed when thread lookup is interrupted", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(1)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.previous.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)
        yield* settleEvents
        received.length = 0

        yield* harness.beginTargetGet
        const selection = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
        yield* Deferred.await(harness.targetGetEntered)
        yield* Fiber.interrupt(selection)
        yield* source.submit("stream after interrupted selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* settleEvents

        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "TranscriptProjectionPatched",
            selectionEpoch: 1,
            threadId: harness.previous.id,
            origin: expect.objectContaining({
              _tag: "Event",
              executionId: "selection-live-turn",
            }),
            delta: expect.objectContaining({ upsert: expect.any(Array), remove: expect.any(Array) }),
          }),
        )
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("preserves committed selection controls and usage when a candidate load fails or is interrupted", () =>
    Effect.forEach(
      ["failed", "interrupted"] as const,
      (mode) =>
        Effect.gen(function* () {
          const harness = yield* makeSelectionLoadHarness(1, true)
          yield* Effect.gen(function* () {
            const source = yield* openInteractiveSession(harness.sessions, {
              _tag: "Interactive",
              prompt: [],
              ephemeral: false,
            })
            const selecting = yield* openInteractiveSession(harness.sessions, {
              _tag: "Interactive",
              prompt: [],
              ephemeral: false,
            })
            const received: Array<InteractiveEvent> = []
            yield* collectEvents(selecting, received)
            yield* source.selectThread(harness.previous.id, 1)
            yield* selecting.selectThread(harness.previous.id, 1)
            yield* source.submit("active committed turn")
            yield* Deferred.await(harness.liveEventsEmitted)
            yield* settleEvents
            received.length = 0

            let candidate: Fiber.Fiber<void, OperationUnavailable> | undefined
            if (mode === "failed") {
              yield* harness.failTargetPage
              yield* selecting.selectThread(harness.target.id, 2)
            } else {
              yield* harness.beginTargetPage
              candidate = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
              yield* Deferred.await(harness.targetPageEntered)
            }
            yield* harness.releaseUsage
            yield* source.steer("control committed turn")
            yield* settleUsage
            if (candidate !== undefined) yield* Fiber.interrupt(candidate)
            yield* settleEvents

            expect(received).toContainEqual(
              expect.objectContaining({
                _tag: "ExecutionControlled",
                selectionEpoch: 1,
                threadId: harness.previous.id,
                action: "steered",
              }),
            )
            expect(received).toContainEqual(
              expect.objectContaining({
                _tag: "ThreadUsageUpdated",
                selectionEpoch: 1,
                threadId: harness.previous.id,
              }),
            )
            expect(
              received.some(
                (event) =>
                  (event._tag === "SelectionLoaded" && event.thread.id === harness.target.id) ||
                  ("threadId" in event &&
                    "selectionEpoch" in event &&
                    event.threadId === harness.target.id &&
                    event.selectionEpoch === 2),
              ),
            ).toBe(false)
            yield* harness.releaseExecution
          }).pipe(provideLayer(harness.layer))
        }),
      { discard: true },
    ),
  )

  it.effect("does not let a failed selection overwrite a newer selection", () =>
    Effect.gen(function* () {
      const previous = selectionThread("selection-rollback-previous")
      const current = selectionThread("selection-rollback-current")
      const repository = yield* ThreadRepository.makeMemory([previous, current])
      const failedLookup = yield* Deferred.make<void>()
      const interleavingRepository = ThreadRepository.Service.of({
        ...repository,
        get: (id) =>
          id === "selection-rollback-missing"
            ? Deferred.succeed(failedLookup, undefined).pipe(Effect.as(undefined))
            : repository.get(id),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, interleavingRepository),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: holdSession(sessions),
      })

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<InteractiveEvent> = []
        yield* collectEvents(session, received)
        yield* session.selectThread(previous.id, 1)
        received.length = 0
        const selectCurrent = yield* Effect.forkChild(
          Deferred.await(failedLookup).pipe(
            Effect.andThen(session.selectThread(current.id, 3)),
            Effect.provideService(Scheduler.MaxOpsBeforeYield, 2_048),
          ),
        )
        yield* session.selectThread("selection-rollback-missing", 2)
        yield* Fiber.join(selectCurrent)
        yield* session.readQueue(current.id)
        yield* settleEvents

        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "SelectionLoaded",
            selectionEpoch: 3,
            thread: expect.objectContaining({ id: current.id }),
          }),
        )
        expect(received).toContainEqual(
          expect.objectContaining({ _tag: "QueueUpdated", selectionEpoch: 3, threadId: current.id }),
        )
      }).pipe(provideLayer(layer), Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
    }),
  )

  it.effect("releases a committed selection feed before an overlapping candidate can fail", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(1, true)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.target.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)

        yield* harness.beginTargetGet
        const selection = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
        yield* Deferred.await(harness.targetGetEntered)
        const execution = yield* Effect.forkChild(source.submit("active target turn"))
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* source.steer("critical during selection")
        yield* harness.releaseUsage
        yield* settleEvents

        expect(
          received.filter(
            (event) =>
              "threadId" in event &&
              "selectionEpoch" in event &&
              event.threadId === harness.target.id &&
              event.selectionEpoch === 2,
          ),
        ).toEqual([])
        const failedCandidate = yield* Effect.forkChild(
          Effect.gen(function* () {
            while (!received.some((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 2))
              yield* Effect.yieldNow
            yield* harness.failTargetPage
            yield* selecting.selectThread(harness.target.id, 3)
          }),
        )
        yield* harness.releaseTargetGet
        yield* Fiber.join(selection)
        yield* Fiber.join(failedCandidate)
        yield* settleEvents
        expect(
          received
            .filter(
              (event) =>
                (event._tag === "SelectionLoaded" && event.thread.id === harness.target.id) ||
                (event._tag === "ExecutionControlled" && event.threadId === harness.target.id),
            )
            .map((event) => event._tag),
        ).toEqual(["SelectionLoaded", "ExecutionControlled"])
        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "ExecutionControlled",
            selectionEpoch: 2,
            threadId: harness.target.id,
            action: "steered",
          }),
        )
        const snapshot = received.find(
          (event) =>
            event._tag === "TranscriptProjectionStarted" &&
            event.selectionEpoch === 2 &&
            event.rootTurnId === "selection-live-turn",
        )
        expect(snapshot).toMatchObject({ patchRevision: 3 })
        expect(
          snapshot?._tag === "TranscriptProjectionStarted"
            ? snapshot.units.some(
                (unit) =>
                  unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === "1",
              )
            : false,
        ).toBe(true)
        expect(
          received.filter(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.selectionEpoch === 2 &&
              event.origin._tag === "Event" &&
              event.origin.type === "model.output.delta",
          ),
        ).toHaveLength(0)
        expect(
          received.filter((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2).length,
        ).toBeGreaterThanOrEqual(1)
        expect(
          received.filter(
            (event) =>
              event._tag === "ExecutionControlled" &&
              event.selectionEpoch === 2 &&
              event.threadId === harness.target.id,
          ),
        ).toHaveLength(1)
        expect(received.filter((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 3)).toHaveLength(
          0,
        )
        yield* harness.releaseExecution
        yield* Fiber.join(execution)
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("loads a durable projection snapshot when activity finishes before the selection watch opens", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(8_193)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.target.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)
        yield* settleEvents
        received.length = 0

        yield* harness.beginTargetGet
        const selection = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
        yield* Deferred.await(harness.targetGetEntered)
        yield* source.submit("overflow during selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* harness.releaseTargetGet
        yield* Fiber.join(selection)
        yield* settleEvents

        expect(received.filter((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 2)).toHaveLength(
          1,
        )
        expect(
          received.find(
            (event) =>
              event._tag === "TranscriptProjectionStarted" &&
              event.selectionEpoch === 2 &&
              event.rootTurnId === "selection-live-turn",
          ),
        ).toMatchObject({ patchRevision: 8_194 })
        expect(received.some((event) => event._tag === "TranscriptResyncRequired" && event.selectionEpoch === 2)).toBe(
          false,
        )

        received.length = 0
        yield* selecting.selectThread(harness.target.id, 3)
        yield* settleEvents
        expect(received.filter((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 3)).toHaveLength(
          1,
        )
        expect(received.some((event) => event._tag === "TranscriptResyncRequired" && event.selectionEpoch === 3)).toBe(
          false,
        )
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("anchors an initially requested thread from one live projection snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(8_193)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const initial = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          threadId: harness.target.id,
          ephemeral: false,
        })
        const received: Array<InteractiveEvent> = []
        yield* collectEvents(initial, received)
        yield* source.selectThread(harness.target.id, 1)
        received.length = 0

        yield* source.submit("overflow before initial selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* initial.selectThread(harness.target.id, 1)
        yield* settleEvents

        expect(received.filter((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 1)).toHaveLength(
          1,
        )
        expect(
          received.find(
            (event) =>
              event._tag === "TranscriptProjectionStarted" &&
              event.selectionEpoch === 1 &&
              event.rootTurnId === "selection-live-turn",
          ),
        ).toMatchObject({ patchRevision: 8_194 })
        expect(received.some((event) => event._tag === "TranscriptResyncRequired" && event.selectionEpoch === 1)).toBe(
          false,
        )
        expect(received.filter((event) => event._tag === "TranscriptProjectionPatched")).toHaveLength(0)
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )
})
