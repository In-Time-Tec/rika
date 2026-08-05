import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionEvent from "@rika/product/execution-event"
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { it as rawIt } from "vitest"

import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { collectEvents, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { makeSelectionLoadHarness } from "../support/operation-selection-harness"
import { operationService } from "./operation-selection-live-feed-support"

describe("Operation", () => {
  rawIt(
    "recovers a complete atomic selection after the source feed exceeds its bounded window",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const eventCount = 8_300
          const streamed: ReadonlyArray<ExecutionEvent.Event> = [
            executionStarted("overflow-live-run"),
            ...Array.from(
              { length: eventCount },
              (_, index): ExecutionEvent.Event => ({
                executionId: "overflow-live-run",
                cursor: `chunk-${index + 1}`,
                sequence: index + 1,
                type: "model.output.delta",
                createdAt: index + 1,
                text: "x",
              }),
            ),
            {
              executionId: "overflow-live-run",
              cursor: "terminal",
              sequence: eventCount + 1,
              type: "execution.completed",
              timestampSource: "baton",
              createdAt: eventCount + 1,
            },
          ]
          const turns = yield* TurnRepository.makeMemory()
          const transcripts = yield* TranscriptRepository.makeMemory({ turns })
          let recovered: Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }> | undefined
          let resyncRequested = false
          const overflowBackend = ExecutionGateway.Service.of({
            ...backend,
            startTurn: (input) =>
              Effect.succeed({ runId: "overflow-live-run", turnId: input.turnId, threadId: input.threadId }),
            watchTurn: () => Stream.fromIterable(streamed),
            inspectTurn: () => Effect.succeed({ status: "completed" }),
          })
          const layer = productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
            backendLayer: Layer.succeed(ExecutionGateway.Service, overflowBackend),
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
                event.origin.executionId === "selection-live-run",
            )
            .map((event) =>
              event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event" ? event.origin.cursor : "",
            ),
        ).toEqual(["selection-live-completed"])
      }).pipe(provideLayer(harness.layer))
    }),
  )
})
