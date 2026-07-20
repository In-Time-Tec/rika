import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { Operation } from "../src/index"
import { executeInteractiveCommand } from "../src/operation-contract"

const baseBackend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: () => Effect.void,
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.void,
  resolvePermission: () => Effect.void,
})

const thread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

const interactiveLayer = (
  repository: ThreadRepository.Interface,
  turns: TurnRepository.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<Operation.InteractiveSession>,
  makeThreadId: Effect.Effect<Thread.ThreadId> = Effect.die("unused"),
  makeTurnId: Effect.Effect<Turn.TurnId> = Effect.die("unused"),
) =>
  Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId,
    makeTurnId,
    interactive: (_, session) => Deferred.succeed(registration, session).pipe(Effect.andThen(Effect.never)),
  })

describe("interactive session extensions", () => {
  it.effect("loads one thread with its child cost and the data-root global total", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("first")
        const second = thread("second")
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("turn-first"),
            threadId: first.id,
            prompt: "first",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: Turn.TurnId.make("turn-second"),
            threadId: second.id,
            prompt: "second",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const executionEvents = new Map<string, ReadonlyArray<ExecutionBackend.Event>>([
          [
            "turn-first",
            [
              {
                cursor: "first-usage",
                sequence: 0,
                type: "model.usage.reported",
                createdAt: 1,
                data: { cost_usd: 1 },
              },
            ],
          ],
          [
            "turn-first-child",
            [
              {
                cursor: "first-child-usage",
                sequence: 0,
                type: "model.usage.reported",
                createdAt: 1,
                data: { cost_usd: 2 },
              },
            ],
          ],
          [
            "turn-second",
            [
              {
                cursor: "second-usage",
                sequence: 0,
                type: "model.usage.reported",
                createdAt: 2,
                data: { cost_usd: 4 },
              },
            ],
          ],
        ])
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed(
              executionEvents.has(executionId)
                ? {
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children:
                      executionId === "turn-first"
                        ? [{ executionId: "turn-first-child", status: "completed" as const }]
                        : [],
                  }
                : undefined,
            ),
          replay: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              events: executionEvents.get(executionId) ?? [],
            }),
        })
        const context = yield* Layer.build(interactiveLayer(repository, turns, backend, registration))
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(first.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBe(3)
        expect(loaded.globalCostUsd).toBe(7)
        expect(new Set(loaded.entries.map((entry) => entry.projectionCostUsd))).toEqual(new Set([3]))

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
            id: Turn.TurnId.make("queued"),
            threadId: previous.id,
            prompt: "queued",
            executionRoute: Turn.testExecutionRoute(),
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
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
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
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
          threadCostUsd: 0,
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

  it.effect("forwards child and nested child events once under normalized execution ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const followed = yield* Ref.make<ReadonlyArray<string>>([])
        const childCallId = "agent"
        const childId = `child:execution%3Aparent-turn:${childCallId}`
        const nestedCallId = "worker"
        const nestedId = `child:${encodeURIComponent(childId)}:${nestedCallId}`
        const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "child-tool",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 3,
            data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/a.ts" } },
          },
          {
            cursor: "child-delegate",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, tool_name: "task", input: { prompt: "run checks" } },
          },
          {
            cursor: "nested-spawn",
            sequence: 2,
            type: "child_run.spawned",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, child_execution_id: nestedId },
          },
          {
            cursor: "child-usage",
            sequence: 3,
            type: "model.usage.reported",
            createdAt: 5,
            data: { cost_usd: 2 },
          },
          {
            cursor: "child-response",
            sequence: 4,
            type: "model.output.completed",
            createdAt: 5,
            text: "## Child complete\n\n**Projection preserved.**",
          },
          { cursor: "child-done", sequence: 5, type: "execution.completed", createdAt: 5 },
        ]
        const nestedEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "nested-tool",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 6,
            data: { tool_call_id: "shell", tool_name: "shell", input: { command: "bun test" } },
          },
          {
            cursor: "nested-response",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 7,
            text: "Nested checks passed.",
          },
          {
            cursor: "nested-usage",
            sequence: 2,
            type: "model.usage.reported",
            createdAt: 7,
            data: { cost_usd: 4 },
          },
          { cursor: "nested-done", sequence: 3, type: "execution.completed", createdAt: 7 },
        ]
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) => {
            const parentEvents: ReadonlyArray<ExecutionBackend.Event> = [
              {
                cursor: "parent-tool",
                sequence: 0,
                type: "tool.call.requested",
                createdAt: 1,
                data: { tool_call_id: childCallId, tool_name: "oracle", input: { prompt: "inspect" } },
              },
              {
                cursor: "child-spawn",
                sequence: 1,
                type: "child_run.spawned",
                createdAt: 2,
                data: { child_execution_id: childId },
              },
              {
                cursor: "parent-usage",
                sequence: 2,
                type: "model.usage.reported",
                createdAt: 8,
                data: { cost_usd: 1 },
              },
              { cursor: "parent-done", sequence: 3, type: "execution.completed", createdAt: 8 },
            ]
            return Effect.sync(() => {
              for (const event of parentEvents) input.onEvent?.(event)
              return { turnId: input.turnId, status: "completed" as const, events: parentEvents }
            })
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
          replay: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              events: executionId === childId ? childEvents : executionId === nestedId ? nestedEvents : [],
            }),
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              waits: [],
              pendingTools: [],
              children:
                executionId === "parent-turn"
                  ? [{ executionId: childId, status: "completed" as const }]
                  : executionId === childId
                    ? [{ executionId: nestedId, status: "completed" as const }]
                    : [],
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
              event._tag === "TranscriptPatched" && event.turnId === nestedId && event.event.cursor === "nested-done",
          )
        )
          yield* Effect.yieldNow

        expect(yield* Ref.get(followed)).toEqual([childId, nestedId])
        const patches = events.filter((event) => event._tag === "TranscriptPatched")
        expect(patches.map((event) => [event.turnId, event.event.cursor])).toEqual([
          ["parent-turn", "parent-tool"],
          ["parent-turn", "child-spawn"],
          ["parent-turn", "parent-usage"],
          ["parent-turn", "parent-done"],
          [childId, "child-tool"],
          [childId, "child-delegate"],
          [childId, "nested-spawn"],
          [childId, "child-usage"],
          [childId, "child-response"],
          [childId, "child-done"],
          [nestedId, "nested-tool"],
          [nestedId, "nested-response"],
          [nestedId, "nested-usage"],
          [nestedId, "nested-done"],
        ])
        expect(patches.find((event) => event.event.cursor === "parent-usage")).toMatchObject({
          rootTurnId: "parent-turn",
          rootTurnCostUsd: 1,
          threadCostUsd: 1,
          globalCostUsd: 1,
        })
        expect(patches.find((event) => event.event.cursor === "child-usage")).toMatchObject({
          rootTurnId: "parent-turn",
          rootTurnCostUsd: 3,
          threadCostUsd: 3,
          globalCostUsd: 3,
        })
        expect(patches.find((event) => event.event.cursor === "nested-usage")).toMatchObject({
          rootTurnId: "parent-turn",
          rootTurnCostUsd: 7,
          threadCostUsd: 7,
          globalCostUsd: 7,
        })
        events.length = 0
        yield* session.selectThread(Thread.ThreadId.make("thread"), 1)
        while (!events.some((event) => event._tag === "SelectionLoaded")) yield* Effect.yieldNow
        const loaded = events.find((event) => event._tag === "SelectionLoaded")
        const loadedEntries = loaded?._tag === "SelectionLoaded" ? loaded.entries : []
        expect(
          loadedEntries.some(
            (entry) => entry.unit.turnId === childId && entry.unit.parentId === `parent-turn:${childCallId}`,
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) => entry.unit.turnId === nestedId && entry.unit.parentId === `${childId}:${nestedCallId}`,
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.parentId === `parent-turn:${childCallId}` &&
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

  it.effect("interrupts child followers on cancel, selection change, and session close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("first")
        const second = thread("second")
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const followed = yield* Queue.unbounded<string>()
        const stopped = yield* Queue.unbounded<string>()
        const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
        const turnSequence = yield* Ref.make(0)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) => {
            const childId = `${input.turnId}:child:worker`
            return Effect.sync(() => {
              input.onEvent?.({
                cursor: `spawn-${input.turnId}`,
                sequence: 0,
                type: "child_run.spawned",
                createdAt: 1,
                data: { child_execution_id: childId },
              })
              return {
                turnId: input.turnId,
                status: "running" as const,
                events: [],
              }
            })
          },
          follow: (executionId) =>
            executionId.includes(":child:")
              ? Queue.offer(followed, executionId).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Queue.offer(stopped, executionId)),
                )
              : Effect.succeed({ turnId: executionId, status: "running" as const, events: [] }),
          inspect: (turnId) =>
            Effect.succeed({
              turnId,
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: turnId.includes(":child:")
                ? []
                : [{ executionId: `${turnId}:child:worker`, status: "running" as const }],
            }),
          cancel: (turnId) =>
            Ref.update(cancelled, (values) => [...values, turnId]).pipe(
              Effect.as({ turnId, status: "cancelled" as const, events: [] }),
            ),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.die("unused"),
          Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
            Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
          ),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const feed = yield* Effect.forkChild(session.events(() => undefined))
        yield* session.selectThread(first.id, 1)

        yield* session.submit("cancelled")
        expect(yield* Queue.take(followed)).toBe("turn-1:child:worker")
        yield* session.cancel
        expect(yield* Queue.take(stopped)).toBe("turn-1:child:worker")
        expect(new Set(yield* Ref.get(cancelled))).toEqual(new Set(["turn-1:child:worker", "turn-1"]))

        yield* session.submit("selected away")
        expect(yield* Queue.take(followed)).toBe("turn-2:child:worker")
        yield* session.selectThread(second.id, 2)
        expect(yield* Queue.take(stopped)).toBe("turn-2:child:worker")

        yield* session.submit("closed")
        expect(yield* Queue.take(followed)).toBe("turn-3:child:worker")
        yield* Fiber.interrupt(operationFiber)
        expect(yield* Queue.take(stopped)).toBe("turn-3:child:worker")
        yield* Fiber.interrupt(feed)
      }),
    ),
  )
})
