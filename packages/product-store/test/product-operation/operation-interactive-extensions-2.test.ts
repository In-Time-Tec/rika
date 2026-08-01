import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import {
  ThreadRepository,
  TranscriptRepository,
  TurnRepository,
  TurnContract,
  Turn,
  ExecutionBackend,
  TranscriptProjection,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  storeProjection,
  baseBackend,
  thread,
  interactiveLayer,
} from "./operation-interactive-extensions-support"

describe("interactive session extensions", () => {
  it.effect("uses current Relay replay without rewriting a persisted checkpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("priced")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const target: Turn.Turn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("turn-priced"),
          threadId: selected.id,
          prompt: "priced",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "completed",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        }
        const turns = yield* TurnRepository.makeMemory([target])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* storeProjection(
          transcripts,
          target,
          { ...TranscriptProjection.Projection.empty(target.id, target.prompt), costUsd: 15 },
          {
            consumed: { [String(target.id)]: { cursor: "", sequence: -1, status: "completed" } },
            projectionVersion: 3,
          },
        )
        let inspections = 0
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) => {
            inspections += 1
            return Effect.succeed(
              executionId === target.id
                ? {
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children: [],
                  }
                : undefined,
            )
          },
          replay: (executionId) => Effect.succeed({ turnId: executionId, status: "completed" as const, events: [] }),
        })
        const registration = yield* Deferred.make<InteractiveSession>()
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
        const events = yield* Queue.unbounded<InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(selected.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBeUndefined()
        expect(loaded.globalCostUsd).toBeUndefined()
        expect(inspections).toBeGreaterThan(0)
        expect(yield* transcripts.get(target.id)).toMatchObject({
          costUsd: 15,
        })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("prevents an obsolete selection epoch from committing after its replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("selection-a")
        const second = thread("selection-b")
        const firstTurn: Turn.Turn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("selection-a-turn"),
          threadId: first.id,
          prompt: "a",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        }
        const secondTurn: Turn.Turn = {
          ...firstTurn,
          id: Turn.TurnId.make("selection-b-turn"),
          threadId: second.id,
          prompt: "b",
        }
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory([firstTurn, secondTurn])
        const firstPageRead = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let selectingFirst = false
        const selectionTurns: TurnContract.Interface = {
          ...turns,
          page: (threadId, options) => {
            const block = selectingFirst && threadId === first.id
            return turns.page(threadId, options).pipe(
              Effect.tap(() => (block ? Deferred.succeed(firstPageRead, undefined) : Effect.void)),
              Effect.tap(() => (block ? Deferred.await(releaseFirst) : Effect.void)),
            )
          },
        }
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: [],
            }),
          replay: (executionId) => Effect.succeed({ turnId: executionId, status: "running" as const, events: [] }),
        })
        const registration = yield* Deferred.make<InteractiveSession>()
        const context = yield* Layer.build(interactiveLayer(repository, selectionTurns, backend, registration))
        const operation = Context.get(context, Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))

        selectingFirst = true
        const firstSelection = yield* Effect.forkChild(session.selectThread(first.id, 1))
        yield* Deferred.await(firstPageRead)
        selectingFirst = false
        const secondSelection = yield* Effect.forkChild(session.selectThread(second.id, 2))
        yield* Fiber.join(secondSelection)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(firstSelection)
        for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow

        expect(events.filter((event) => event._tag === "SelectionLoaded").map((event) => event.thread.id)).toEqual([
          second.id,
        ])
        expect(events.some((event) => event._tag === "SelectionLoaded" && event.thread.id === first.id)).toBe(false)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )
})
