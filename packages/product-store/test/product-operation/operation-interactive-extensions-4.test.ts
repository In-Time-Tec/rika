import { describe, expect, it } from "@effect/vitest"
import {
  ThreadRepository,
  Thread,
  TurnRepository,
  Turn,
  ExecutionBackend,
  TranscriptIdentity,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Ref,
  Operation,
  baseBackend,
  providerCostEvent,
  interactiveLayer,
} from "./operation-interactive-extensions-support"

describe("interactive session extensions", () => {
  it.effect("forwards child and nested child events once under normalized execution ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const followed = yield* Ref.make<ReadonlyArray<string>>([])
        const startEventScopes = yield* Ref.make<ReadonlyArray<ExecutionBackend.EventScope | undefined>>([])
        const childCallId = "agent"
        const childId = `child:execution%3Aparent-turn:${childCallId}`
        const nestedCallId = "worker"
        const nestedId = `child:${encodeURIComponent(childId)}:${nestedCallId}`
        const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            executionId: childId,
            cursor: "child-started",
            sequence: 0,
            type: "execution.started",
            createdAt: 2,
            timestampSource: "server",
          },
          {
            executionId: childId,
            cursor: "child-tool",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 3,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            executionId: childId,
            cursor: "child-delegate",
            sequence: 2,
            type: "tool.call.requested",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, tool_name: "task", input: { prompt: "run checks" } },
          },
          {
            executionId: childId,
            cursor: "nested-spawn",
            sequence: 3,
            type: "child_run.spawned",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, child_execution_id: nestedId },
          },
          providerCostEvent(childId, "child-usage", 2, 4),
          {
            executionId: childId,
            cursor: "child-response",
            sequence: 5,
            type: "model.output.completed",
            createdAt: 5,
            text: "## Child complete\n\n**Projection preserved.**",
          },
          {
            executionId: childId,
            cursor: "child-done",
            sequence: 6,
            type: "execution.completed",
            createdAt: 5,
            timestampSource: "server",
          },
        ]
        const nestedEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            executionId: nestedId,
            cursor: "nested-started",
            sequence: 0,
            type: "execution.started",
            createdAt: 5,
            timestampSource: "server",
          },
          {
            executionId: nestedId,
            cursor: "nested-tool",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 6,
            data: { tool_call_id: "bash", tool_name: "bash", input: { command: "bun test" } },
          },
          {
            executionId: nestedId,
            cursor: "nested-response",
            sequence: 2,
            type: "model.output.completed",
            createdAt: 7,
            text: "Nested checks passed.",
          },
          providerCostEvent(nestedId, "nested-usage", 4, 3),
          {
            executionId: nestedId,
            cursor: "nested-done",
            sequence: 4,
            type: "execution.completed",
            createdAt: 7,
            timestampSource: "server",
          },
        ]
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) => {
            const parentEvents: ReadonlyArray<ExecutionBackend.Event> = [
              {
                executionId: input.turnId,
                cursor: "parent-started",
                sequence: 0,
                type: "execution.started",
                createdAt: 0,
                timestampSource: "server",
              },
              {
                executionId: input.turnId,
                cursor: "parent-tool",
                sequence: 1,
                type: "tool.call.requested",
                createdAt: 1,
                data: { tool_call_id: childCallId, tool_name: "oracle", input: { prompt: "inspect" } },
              },
              {
                executionId: input.turnId,
                cursor: "child-spawn",
                sequence: 2,
                type: "child_run.spawned",
                createdAt: 2,
                data: { child_execution_id: childId },
              },
              providerCostEvent(String(input.turnId), "parent-usage", 1, 3),
              {
                executionId: input.turnId,
                cursor: "parent-done",
                sequence: 4,
                type: "execution.completed",
                createdAt: 8,
                timestampSource: "server",
              },
            ]
            return Ref.update(startEventScopes, (values) => [...values, input.eventScope]).pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const event of parentEvents) input.onEvent?.(event)
                }),
              ),
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: parentEvents }),
            )
          },
          follow: (executionId, _afterCursor, onEvent) => {
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            const events = executionId === childId ? childEvents : nestedEvents
            return Ref.update(followed, (values) => [...values, executionId]).pipe(
              Effect.tap(() => Effect.sync(() => events.forEach((event) => onEvent?.(event)))),
              Effect.as({ turnId: executionId, status: "completed" as const, events }),
            )
          },
          replay: (executionId) => {
            let events: ReadonlyArray<ExecutionBackend.Event> = []
            if (executionId === childId) events = childEvents
            else if (executionId === nestedId) events = nestedEvents
            return Effect.succeed({ turnId: executionId, status: "completed" as const, events })
          },
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              waits: [],
              pendingTools: [],
              children: [],
            }),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.succeed(Thread.ThreadId.make("thread")),
          Effect.succeed(Turn.TurnId.make("parent-turn")),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* Effect.yieldNow

        yield* session.submit("delegate")
        while (
          !events.some(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.executionId === nestedId &&
              event.origin.cursor === "nested-done",
          )
        )
          yield* Effect.yieldNow

        expect((yield* Ref.get(followed)).toSorted()).toEqual([childId, nestedId].toSorted())
        expect(yield* Ref.get(startEventScopes)).toEqual(["execution"])
        const patched = events.flatMap((event) =>
          event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event"
            ? [`${event.origin.executionId} ${event.origin.cursor}`]
            : [],
        )
        expect(patched.toSorted()).toEqual(
          [
            "parent-turn parent-started",
            "parent-turn parent-tool",
            "parent-turn child-spawn",
            "parent-turn parent-usage",
            "parent-turn parent-done",
            `${childId} child-started`,
            `${childId} child-tool`,
            `${childId} child-delegate`,
            `${childId} nested-spawn`,
            `${childId} child-usage`,
            `${childId} child-response`,
            `${childId} child-done`,
            `${nestedId} nested-started`,
            `${nestedId} nested-tool`,
            `${nestedId} nested-response`,
            `${nestedId} nested-usage`,
            `${nestedId} nested-done`,
          ].toSorted(),
        )
        expect(
          events.find(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "parent-usage",
          ),
        ).toMatchObject({
          rootTurnId: "parent-turn",
          delta: { upsert: expect.any(Array), remove: expect.any(Array) },
        })
        expect(
          events.find(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "child-usage",
          ),
        ).toMatchObject({
          rootTurnId: "parent-turn",
        })
        expect(
          events.find(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "nested-usage",
          ),
        ).toMatchObject({
          rootTurnId: "parent-turn",
        })
        events.length = 0
        yield* session.selectThread(Thread.ThreadId.make("thread"), 1)
        while (!events.some((event) => event._tag === "SelectionLoaded")) yield* Effect.yieldNow
        const loaded = events.find((event) => event._tag === "SelectionLoaded")
        const loadedEntries = loaded?._tag === "SelectionLoaded" ? loaded.entries : []
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.turnId === childId &&
              entry.unit.parentId === TranscriptIdentity.scopedIdentity("parent-turn", childCallId),
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.turnId === nestedId &&
              entry.unit.parentId === TranscriptIdentity.scopedIdentity(childId, nestedCallId),
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.parentId === TranscriptIdentity.scopedIdentity("parent-turn", childCallId) &&
              entry.unit.content._tag === "Entry" &&
              entry.unit.content.role === "assistant" &&
              entry.unit.content.text === "## Child complete\n\n**Projection preserved.**",
          ),
        ).toBe(true)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("follows every discovered child without waiting for earlier children", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const releaseChildren = yield* Deferred.make<void>()
        const allChildrenStarted = yield* Deferred.make<void>()
        const followed = yield* Ref.make<ReadonlyArray<string>>([])
        const childIds = Array.from({ length: 12 }, (_, index) => `child:execution%3Aparent-turn:worker-${index}`)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Effect.sync(() => {
              for (const [sequence, childId] of childIds.entries())
                input.onEvent?.({
                  executionId: input.turnId,
                  cursor: `spawn-${sequence}`,
                  sequence,
                  type: "child_run.spawned",
                  createdAt: sequence,
                  data: { child_execution_id: childId },
                })
              return { turnId: input.turnId, status: "running" as const, events: [] }
            }),
          follow: (executionId, _afterCursor, onEvent) => {
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            return Ref.updateAndGet(followed, (values) => [...values, executionId]).pipe(
              Effect.tap((values) =>
                Effect.sync(() =>
                  onEvent?.({
                    executionId,
                    cursor: "started",
                    sequence: 0,
                    type: "model.output.delta",
                    createdAt: 1,
                    text: "started",
                  }),
                ).pipe(
                  Effect.andThen(
                    values.length === childIds.length ? Deferred.succeed(allChildrenStarted, undefined) : Effect.void,
                  ),
                ),
              ),
              Effect.andThen(Deferred.await(releaseChildren)),
              Effect.as({ turnId: executionId, status: "running" as const, events: [] }),
            )
          },
        })
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.succeed(Thread.ThreadId.make("thread")),
            Effect.succeed(Turn.TurnId.make("parent-turn")),
          ),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* Effect.yieldNow

        yield* session.submit("delegate broadly")
        yield* Deferred.await(allChildrenStarted)

        expect(new Set(yield* Ref.get(followed))).toEqual(new Set(childIds))
        const startedChildren = () =>
          events.flatMap((event) =>
            event._tag === "TranscriptProjectionPatched" &&
            event.origin._tag === "Event" &&
            event.origin.type === "model.output.delta"
              ? [event.origin.executionId]
              : [],
          )
        while (startedChildren().length < childIds.length) yield* Effect.yieldNow
        expect(new Set(startedChildren())).toEqual(new Set(childIds))
        expect(startedChildren()).toHaveLength(childIds.length)

        yield* Deferred.succeed(releaseChildren, undefined)
        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )
})
