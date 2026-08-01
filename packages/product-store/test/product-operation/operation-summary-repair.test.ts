import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "@rika/product/product-operation-service"
import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("uses the configured interactive operation", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
      const input: Operation.Input = {
        _tag: "Interactive",
        prompt: ["hello"],
        workspace: "/interactive",
        ephemeral: false,
      }
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run(input)
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: TurnRepository.memoryLayer(),
            backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
            interactive: (interactiveInput) => Ref.update(received, (inputs) => [...inputs, interactiveInput]),
          }),
        ),
      )
      expect(yield* Ref.get(received)).toEqual([input])
    }),
  )

  it.effect("drains more than one batch of thread summary repairs", () =>
    Effect.gen(function* () {
      const thread = selectionThread("summary-repair-thread")
      const turns = Array.from(
        { length: 101 },
        (_, index): Turn.Turn => ({
          id: Turn.TurnId.make(`summary-repair-${index}`),
          ...turnProvenance,
          threadId: thread.id,
          prompt: `repair ${index}`,
          executionRoute: executionRoute(),
          status: "completed",
          stopIntent: "none",
          createdAt: index + 1,
          updatedAt: index + 1,
        }),
      )
      const inspections = yield* Ref.make<ReadonlyArray<string>>([])
      const repairBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Ref.update(inspections, (values) => [...values, String(turnId)]).pipe(
            Effect.as({ turnId, status: "completed" as const, waits: [], pendingTools: [], children: [] }),
          ),
        replay: (turnId) =>
          Effect.succeed({
            turnId,
            status: "completed" as const,
            events: [
              executionStarted(String(turnId)),
              {
                executionId: String(turnId),
                cursor: `summary-repair-completed-${turnId}`,
                sequence: 1,
                type: "execution.completed" as const,
                timestampSource: "server" as const,
                createdAt: 1,
              },
            ],
          }),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["continue"],
          threadId: thread.id,
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: TurnRepository.memoryLayer(turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, repairBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("continued-turn")),
          }),
        ),
      )
      expect(new Set((yield* Ref.get(inspections)).filter((turnId) => turnId.startsWith("summary-repair-"))).size).toBe(
        101,
      )
    }),
  )

  it.effect("opens the interactive operation without waiting for thread summary repair", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = selectionThread("summary-repair-startup-thread")
        const turn: Turn.Turn = {
          id: Turn.TurnId.make("summary-repair-startup-turn"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "repair",
          executionRoute: executionRoute(),
          status: "completed",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        }
        const repairStarted = yield* Deferred.make<void>()
        const releaseRepair = yield* Deferred.make<void>()
        const opened = yield* Deferred.make<void>()
        const repairBackend = ExecutionBackend.Service.of({
          ...backend,
          inspect: (turnId) =>
            String(turnId) === String(turn.id)
              ? Deferred.succeed(repairStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRepair)),
                  Effect.as({ turnId, status: "completed" as const, waits: [], pendingTools: [], children: [] }),
                )
              : Effect.void.pipe(Effect.as(undefined)),
        })
        const context = yield* Layer.build(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: TurnRepository.memoryLayer([turn]),
            backendLayer: Layer.succeed(ExecutionBackend.Service, repairBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: () => Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], workspace: "/work", ephemeral: false }),
        )

        yield* Deferred.await(opened)
        expect((yield* Deferred.poll(repairStarted))._tag).toBe("None")
        yield* TestClock.adjust("2 seconds")
        yield* Deferred.await(repairStarted)

        yield* Deferred.succeed(releaseRepair, undefined)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("repairs each orphan once in the owner scope and scans again on reconnect", () =>
    Effect.gen(function* () {
      const thread = selectionThread("repair-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("repair-one"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "repair one",
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const callbacks = yield* Ref.make(0)
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const repairBackend = ExecutionBackend.Service.of({
        ...backend,
        follow: () => Effect.die("missing executions must be repaired before follow"),
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.andThen(
              input.turnId === "repair-one"
                ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                : Effect.void,
            ),
            Effect.andThen(backend.start(input)),
          ),
      })
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, repairBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: () => Ref.update(callbacks, (count) => count + 1),
      })

      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        const reconnects = yield* Effect.forEach(["/one", "/two"], (workspace) =>
          Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], workspace, ephemeral: false })),
        )
        yield* TestClock.adjust("2 seconds")
        yield* Deferred.await(firstStarted)
        yield* settleEvents
        const callbacksBeforeRepairFinished = yield* Ref.get(callbacks)
        expect(yield* Ref.get(starts)).toEqual(["repair-one"])
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Effect.forEach(reconnects, Fiber.join, { discard: true })
        expect(callbacksBeforeRepairFinished).toBe(2)

        yield* turns.createForSubmission({
          id: Turn.TurnId.make("repair-two"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "repair two",
          executionRoute: executionRoute(),
          queueCapacity: 64,
          now: 2,
        })
        yield* turns.setStatus(Turn.TurnId.make("repair-two"), "running", undefined, 2)
        yield* operation.run({ _tag: "Interactive", prompt: [], workspace: "/three", ephemeral: false })
        yield* TestClock.adjust("2 seconds")
        yield* settleEvents
        expect(yield* Ref.get(starts)).toEqual(["repair-one", "repair-two"])
      }).pipe(provideLayer(layer))
    }),
  )

  it.effect("coalesces concurrent reconnect repairs into one scan and one requested rescan", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.makeMemory()
      const scans = yield* Ref.make(0)
      const firstScanStarted = yield* Deferred.make<void>()
      const releaseFirstScan = yield* Deferred.make<void>()
      const countedTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Ref.updateAndGet(scans, (count) => count + 1).pipe(
          Effect.tap((count) => (count === 1 ? Deferred.succeed(firstScanStarted, undefined) : Effect.void)),
          Effect.tap((count) => (count === 1 ? Deferred.await(releaseFirstScan) : Effect.void)),
          Effect.andThen(turns.listNonterminal),
        ),
      })
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, countedTurns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: () => Effect.void,
      })

      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* Effect.forEach(
          Array.from({ length: 20 }),
          (_, index) =>
            operation.run({
              _tag: "Interactive",
              prompt: [],
              workspace: `/reconnect-${index}`,
              ephemeral: false,
            }),
          { concurrency: "unbounded", discard: true },
        )
        yield* TestClock.adjust("2 seconds")
        yield* Deferred.await(firstScanStarted)
        yield* Deferred.succeed(releaseFirstScan, undefined)
        while ((yield* Ref.get(scans)) < 2) yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(scans)).toBe(2)
    }),
  )

  it.effect("retains a complete submission before the event feed attaches", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("prefeed-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("prefeed-turn")),
        interactive: (_, session) =>
          Effect.gen(function* () {
            yield* session.submit("before feed")
            const terminal = yield* Queue.unbounded<void>()
            yield* Effect.raceFirst(
              session.events((event) => {
                runSync(Ref.update(received, (events) => [...events, event]))
                if (event._tag === "TranscriptProjectionStopped" && event.status === "completed")
                  Queue.offerUnsafe(terminal, undefined)
              }),
              Queue.take(terminal),
            )
          }),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const events = yield* Ref.get(received)
      const selectionIndex = events.findIndex((event) => event._tag === "SelectionLoaded")
      const snapshotIndex = events.findIndex((event) => event._tag === "TranscriptProjectionStarted")
      const firstPatchIndex = events.findIndex((event) => event._tag === "TranscriptProjectionPatched")
      expect(selectionIndex).toBeGreaterThanOrEqual(0)
      expect(snapshotIndex).toBeGreaterThan(selectionIndex)
      expect(firstPatchIndex).toBeGreaterThan(snapshotIndex)
      const selections = events.filter((event) => event._tag === "SelectionLoaded")
      expect(selections).toHaveLength(1)
      expect(selections[0]).toMatchObject({
        selectionEpoch: 0,
        thread: { id: "prefeed-thread" },
        entries: [],
      })
      expect(selections[0]?._tag === "SelectionLoaded" ? selections[0].activeTurn : undefined).toBeUndefined()
      const snapshots = events.filter((event) => event._tag === "TranscriptProjectionStarted")
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        selectionEpoch: 0,
        threadId: "prefeed-thread",
        rootTurnId: "prefeed-turn",
      })
      expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
      expect(
        events
          .filter((event) => event._tag === "TranscriptProjectionPatched")
          .map((event) =>
            event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event" ? event.origin.cursor : "",
          ),
      ).toEqual(["cursor-started", "cursor-a", "cursor-b"])
    }),
  )
})
