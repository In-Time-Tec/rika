import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { executeInteractiveCommand } from "@rika/product/interactive-command"
import * as UsageCost from "@rika/product/usage-projection"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { storeProjection, baseBackend, thread, interactiveLayer } from "./operation-interactive-extensions-support"

describe("interactive session extensions", () => {
  it.effect("loads one thread with its child cost and the data-root global total", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("first")
        const second = thread("second")
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory([
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("turn-first"),
            threadId: first.id,
            prompt: "first",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "completed",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("turn-second"),
            threadId: second.id,
            prompt: "second",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "completed",
            stopIntent: "none",
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        const registration = yield* Deferred.make<InteractiveSession>()
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        for (const turnId of ["turn-first", "turn-second"] as const) {
          const target = (yield* turns.get(Turn.TurnId.make(turnId)))!
          if (target._tag !== "AgentExecution") return yield* Effect.die(`Expected agent execution turn ${turnId}`)
          yield* storeProjection(
            transcripts,
            target,
            TranscriptProjection.Projection.project(target.id, target.prompt, [
              {
                cursor: `${turnId}-completed`,
                sequence: 1,
                type: "execution.completed",
                createdAt: 1,
              },
            ]),
            {
              consumed: {
                [String(target.id)]: { cursor: `${turnId}-completed`, sequence: 1, status: "completed" },
              },
              projectionVersion: 3,
            },
          )
        }
        const usageContext = yield* Layer.build(UsageRepository.memoryLayer)
        const usage = Context.get(usageContext, UsageRepository.Service)
        const firstFold = UsageCost.serialize(UsageCost.empty)
        const secondFold = UsageCost.serialize(UsageCost.empty)
        yield* usage.admitSource("turn-first", "turn-first", String(first.id))
        yield* usage.commitSource("turn-first", "turn-first", 0, firstFold, {
          costNanoUsd: 5_000_000_000,
          tokens: 50,
          activeMillis: 500,
          activeIntervals: [{ start: 0, end: 500 }],
          pricedAttempts: 2,
          unpricedAttempts: 0,
          countedAttempts: 2,
          uncountedAttempts: 0,
          sourceComplete: true,
        })
        yield* usage.admitSource("turn-second", "turn-second", String(second.id))
        yield* usage.commitSource("turn-second", "turn-second", 0, secondFold, {
          costNanoUsd: 8_000_000_000,
          tokens: 80,
          activeMillis: 800,
          activeIntervals: [{ start: 500, end: 1_300 }],
          pricedAttempts: 1,
          unpricedAttempts: 0,
          countedAttempts: 1,
          uncountedAttempts: 0,
          sourceComplete: true,
        })
        let backendReads = 0
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: () => {
            backendReads += 1
            return Effect.void.pipe(Effect.as(undefined))
          },
          replay: (turnId) => {
            backendReads += 1
            return Effect.succeed({ turnId, status: "completed" as const, events: [] })
          },
        })
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.die("unused"),
            transcripts,
            usage,
          ),
        )
        const operation = Context.get(context, Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(first.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBeUndefined()
        expect(loaded.globalCostUsd).toBeUndefined()
        const transcriptRepairReads = backendReads
        let refreshed = yield* Queue.take(events)
        while (refreshed._tag !== "ThreadUsageUpdated" || refreshed.threadId !== first.id)
          refreshed = yield* Queue.take(events)
        expect(refreshed).toMatchObject({
          cost: { _tag: "Available", usd: 5 },
          tokens: { _tag: "Available", total: 50 },
          time: { _tag: "Available", accumulatedMillis: 500 },
        })
        expect(backendReads).toBe(transcriptRepairReads)
        expect(yield* usage.readGlobal).toMatchObject({ costNanoUsd: 13_000_000_000 })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("rejects an inspected child with no durable parent tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("synth")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory([
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("turn-synth"),
            threadId: selected.id,
            prompt: "synth",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "completed",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const childId = "turn-synth-child"
        const rootEvents: ReadonlyArray<ExecutionEvent.Event> = [
          {
            executionId: "turn-synth",
            cursor: "root-answer",
            sequence: 0,
            type: "model.output.completed",
            createdAt: 1,
            text: "Delegated.",
          },
        ]
        const childEvents: ReadonlyArray<ExecutionEvent.Event> = [
          {
            executionId: childId,
            cursor: "child-read",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 2,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            executionId: childId,
            cursor: "child-answer",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 3,
            text: "Child finished.",
          },
        ]
        const registration = yield* Deferred.make<InteractiveSession>()
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) => {
            if (executionId === "turn-synth") {
              return Effect.succeed({
                turnId: executionId,
                status: "completed" as const,
                waits: [],
                pendingTools: [],
                children: [{ executionId: childId, status: "completed" as const }],
              })
            }
            if (executionId === childId) {
              return Effect.succeed({
                turnId: executionId,
                status: "completed" as const,
                waits: [],
                pendingTools: [],
                children: [],
              })
            }
            return Effect.void.pipe(Effect.as(undefined))
          },
          replay: (executionId) => {
            let events: ReadonlyArray<ExecutionEvent.Event> = []
            if (executionId === "turn-synth") events = rootEvents
            else if (executionId === childId) events = childEvents
            return Effect.succeed({ turnId: executionId, status: "completed" as const, events })
          },
        })
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.die("unused"),
            transcripts,
          ),
        )
        const operation = Context.get(context, Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))

        yield* session.selectThread(selected.id, 1)
        for (let attempt = 0; attempt < 500 && !events.some((event) => event._tag === "ExecutionFailed"); attempt += 1)
          yield* Effect.yieldNow

        expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(true)
        expect(yield* transcripts.get(Turn.TurnId.make("turn-synth"))).toBeUndefined()

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("creates and adopts a fresh selected thread before the next submission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previous = thread("previous")
        const repository = yield* ThreadRepository.makeMemory([previous])
        const turns = yield* TurnRepository.makeMemory([
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("queued"),
            threadId: previous.id,
            prompt: "queued",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "queued",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const registration = yield* Deferred.make<InteractiveSession>()
        const starts = yield* Ref.make<ReadonlyArray<Parameters<ExecutionBackend.Interface["start"]>[0]>>([])
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Ref.update(starts, (values) => [...values, input]).pipe(
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
            ),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.succeed(Thread.ThreadId.make("fresh")),
          Effect.succeed(Turn.TurnId.make("fresh-turn")),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(previous.id, 4)
        let selected = yield* Queue.take(events)
        while (selected._tag !== "SelectionLoaded") selected = yield* Queue.take(events)
        yield* executeInteractiveCommand(session, { _tag: "NewThread" })
        let fresh = yield* Queue.take(events)
        while (fresh._tag !== "SelectionLoaded" || fresh.thread.id !== "fresh") fresh = yield* Queue.take(events)

        expect(fresh).toMatchObject({
          selectionEpoch: 5,
          thread: { id: "fresh", title: "New thread" },
          entries: [],
          hasOlder: false,
          queueRevision: 0,
          queuedCount: 0,
          queue: [],
        })
        expect(yield* repository.get(Thread.ThreadId.make("fresh"))).toMatchObject({ title: "New thread" })

        yield* session.submit("lands here")
        while ((yield* Ref.get(starts)).length === 0) yield* Effect.yieldNow
        expect((yield* Ref.get(starts))[0]).toMatchObject({ threadId: "fresh", turnId: "fresh-turn" })
        expect(yield* turns.readQueue(previous.id)).toMatchObject({ queuedCount: 1 })
        expect(yield* turns.readQueue(Thread.ThreadId.make("fresh"))).toMatchObject({ queuedCount: 0, turns: [] })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )
})
