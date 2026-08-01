import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import { Clock, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { it as rawIt } from "vitest"

import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { collectEvents, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { turnProvenance, threadLineage } from "../support/operation-selection-fixtures"
import { makeSelectionLoadHarness } from "../support/operation-selection-harness"
import { operationService, testExecutionRoute } from "./operation-selection-live-feed-support"
import type { ThreadQueueWake, TurnPromoter } from "./operation-selection-live-feed-support"

describe("Operation", () => {
  rawIt("publishes one promoted lifecycle and one copy of every streamed cursor to every session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const thread: Thread.Thread = {
          id: Thread.ThreadId.make("promoted-thread"),
          lineage: threadLineage,
          workspace: "/work",
          title: "Promoted",
          labels: [],
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
        }
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("promoted-turn"),
            ...turnProvenance,
            threadId: thread.id,
            prompt: "queued",
            status: "queued",
            stopIntent: "none",
            executionRoute: testExecutionRoute("medium"),
            createdAt: yield* Clock.currentTimeMillis,
            updatedAt: yield* Clock.currentTimeMillis,
          },
        ])
        const starts = yield* Ref.make<ReadonlyArray<string>>([])
        const promoters = yield* Ref.make<ReadonlyArray<TurnPromoter>>([])
        const wakes = yield* Ref.make<ReadonlyArray<ThreadQueueWake>>([])
        const sessions = yield* Queue.unbounded<{
          readonly workspace: string
          readonly session: InteractiveSession
        }>()
        const events = new Map<string, Array<InteractiveEvent>>()
        const feedCompleted = Symbol("feed-completed")
        const streamed = [
          executionStarted("promoted-turn"),
          {
            executionId: "promoted-turn",
            cursor: "streamed",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 3,
            text: "done",
          },
          {
            executionId: "promoted-turn",
            cursor: "terminal",
            sequence: 2,
            type: "execution.completed",
            timestampSource: "server",
            createdAt: 4,
          },
        ] as const
        const promotedBackend = ExecutionBackend.Service.of({
          ...backend,
          start: (input) =>
            Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const event of streamed) input.onEvent?.(event)
                }),
              ),
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: streamed }),
            ),
          wakeThreadHost: (wake) => Ref.update(wakes, (values) => [...values, wake]),
          registerTurnPromoter: (promoter) => Ref.update(promoters, (values) => [...values, promoter]),
        })
        const layer = productLayer({
          repositoryLayer: ThreadRepository.memoryLayer([thread]),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, promotedBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
          interactive: (input, session) =>
            Effect.gen(function* () {
              const workspace = input.workspace ?? "unknown"
              events.set(workspace, [])
              yield* Queue.offer(sessions, { workspace, session })
              yield* session
                .events((event) => {
                  events.get(workspace)!.push(event)
                  if (event._tag === "TranscriptProjectionStopped" && event.status === "completed") throw feedCompleted
                })
                .pipe(Effect.catchDefect((defect) => (defect === feedCompleted ? Effect.void : Effect.die(defect))))
            }),
        })
        yield* Effect.gen(function* () {
          const operation = yield* operationService
          const coordinate = Effect.gen(function* () {
            const one = yield* Queue.take(sessions)
            const two = yield* Queue.take(sessions)
            yield* Effect.all([one.session.selectThread(thread.id, 1), two.session.selectThread(thread.id, 1)], {
              concurrency: 2,
            })
            while ((yield* Ref.get(wakes)).length === 0) yield* Effect.sleep("10 millis")
            const promoter = (yield* Ref.get(promoters))[0]
            const wake = (yield* Ref.get(wakes))[0]
            if (promoter === undefined || wake === undefined) return yield* Effect.die("Missing promoter wake")
            expect(yield* promoter(thread.id, wake.generation)).toBe(1)
          })
          yield* Effect.all(
            [
              operation.run({ _tag: "Interactive", prompt: [], workspace: "/one", ephemeral: false }),
              operation.run({ _tag: "Interactive", prompt: [], workspace: "/two", ephemeral: false }),
              coordinate,
            ],
            { concurrency: 3, discard: true },
          )
        }).pipe(provideLayer(layer))
        expect(yield* Ref.get(starts)).toEqual(["promoted-turn"])
        for (const received of events.values()) {
          expect(received.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
          expect(
            received
              .filter((event) => event._tag === "TranscriptProjectionPatched")
              .map((event) =>
                event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event"
                  ? event.origin.cursor
                  : "",
              ),
          ).toEqual(["promoted-turn:started", "streamed", "terminal"])
        }
      }),
    ),
  )

  rawIt(
    "recovers a complete atomic selection after the source feed exceeds its bounded window",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const eventCount = 8_300
          const streamed: ReadonlyArray<ExecutionEvent.Event> = [
            executionStarted("overflow-turn"),
            ...Array.from(
              { length: eventCount },
              (_, index): ExecutionEvent.Event => ({
                executionId: "overflow-turn",
                cursor: `chunk-${index + 1}`,
                sequence: index + 1,
                type: "model.output.delta",
                createdAt: index + 1,
                text: "x",
              }),
            ),
            {
              executionId: "overflow-turn",
              cursor: "terminal",
              sequence: eventCount + 1,
              type: "execution.completed",
              timestampSource: "server",
              createdAt: eventCount + 1,
            },
          ]
          const turns = yield* TurnRepository.makeMemory()
          const transcripts = yield* TranscriptRepository.makeMemory({ turns })
          let recovered: Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }> | undefined
          let resyncRequested = false
          const overflowBackend = ExecutionBackend.Service.of({
            ...backend,
            start: (input) =>
              Effect.sync(() => {
                for (const event of streamed) input.onEvent?.(event)
                return { turnId: input.turnId, status: "completed" as const, events: streamed }
              }),
            inspect: (turnId) =>
              Effect.succeed({ turnId, status: "completed" as const, waits: [], pendingTools: [], children: [] }),
            replay: (turnId) => Effect.succeed({ turnId, status: "completed" as const, events: streamed }),
          })
          const layer = productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
            backendLayer: Layer.succeed(ExecutionBackend.Service, overflowBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("overflow-thread")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("overflow-turn")),
            interactive: (_, session) =>
              Effect.gen(function* () {
                yield* session.submit("overflow")
                const received = yield* Queue.unbounded<InteractiveEvent>()
                const recover = Effect.gen(function* () {
                  while (true) {
                    const event = yield* Queue.take(received)
                    if (event._tag === "TranscriptResyncRequired") {
                      resyncRequested = true
                      yield* session.selectThread(event.threadId, event.selectionEpoch + 1)
                    }
                    if (event._tag === "SelectionLoaded" && resyncRequested) {
                      recovered = event
                      return
                    }
                  }
                })
                yield* Effect.raceFirst(
                  session.events((event) => Queue.offerUnsafe(received, event)),
                  recover,
                )
              }),
          })
          yield* Effect.gen(function* () {
            const operation = yield* operationService
            yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
          }).pipe(provideLayer(layer))
          expect(recovered).toBeDefined()
          expect(recovered?.selectionEpoch).toBe(1)
          expect(recovered?.activeTurn).toBeUndefined()
          expect(Math.max(...(recovered?.entries.map((entry) => entry.projectionRevision) ?? []))).toBe(eventCount + 1)
          expect(
            recovered?.entries
              .flatMap((entry) => (entry.unit.content._tag === "Entry" ? [entry.unit.content] : []))
              .filter((entry) => entry.role === "assistant")
              .map((entry) => entry.text)
              .join(""),
          ).toHaveLength(eventCount)
        }),
      ),
    30_000,
  )

  it.effect("anchors a selection to the current live projection before delivering future patches", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(3)
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
        yield* source.submit("stream during selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* harness.releaseTargetGet
        yield* Fiber.join(selection)
        yield* settleEvents

        const selected = received.find((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 2)
        const started = received.find(
          (event) =>
            event._tag === "TranscriptProjectionStarted" &&
            event.selectionEpoch === 2 &&
            event.rootTurnId === "selection-live-turn",
        )
        expect(selected).toBeDefined()
        expect(started).toMatchObject({ patchRevision: 4 })
        expect(
          started?._tag === "TranscriptProjectionStarted"
            ? started.units.some(
                (unit) =>
                  unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === "123",
              )
            : false,
        ).toBe(true)
        expect(
          received.some(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor.startsWith("selection-live-") &&
              event.origin.cursor !== "selection-live-completed",
          ),
        ).toBe(false)

        yield* harness.releaseExecution
        while ((yield* harness.turns.get(Turn.TurnId.make("selection-live-turn")))?.status !== "completed")
          yield* Effect.yieldNow
        while (
          !received.some(
            (event) => event._tag === "TranscriptProjectionStopped" && event.rootTurnId === "selection-live-turn",
          )
        )
          yield* Effect.yieldNow
        yield* settleEvents
        expect(
          received
            .filter(
              (event) =>
                event._tag === "TranscriptProjectionPatched" &&
                event.origin._tag === "Event" &&
                event.origin.executionId === "selection-live-turn",
            )
            .map((event) =>
              event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event" ? event.origin.cursor : "",
            ),
        ).toEqual(["selection-live-completed"])
      }).pipe(provideLayer(harness.layer))
    }),
  )
})
