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
        const childId = "parent-turn:child:oracle"
        const nestedId = "parent-turn:child:oracle:child:worker"
        const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "child-tool",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 3,
            data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/a.ts" } },
          },
          {
            cursor: "nested-spawn",
            sequence: 1,
            type: "child_run.spawned",
            createdAt: 4,
            data: { tool_call_id: "delegate", child_execution_id: `execution:${nestedId}` },
          },
          { cursor: "child-done", sequence: 2, type: "execution.completed", createdAt: 5 },
        ]
        const nestedEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "nested-tool",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 6,
            data: { tool_call_id: "shell", tool_name: "shell", input: { command: "bun test" } },
          },
          { cursor: "nested-done", sequence: 1, type: "execution.completed", createdAt: 7 },
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
                data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "inspect" } },
              },
              {
                cursor: "child-spawn",
                sequence: 1,
                type: "child_run.spawned",
                createdAt: 2,
                data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
              },
              { cursor: "parent-done", sequence: 2, type: "execution.completed", createdAt: 8 },
            ]
            return Effect.sync(() => {
              for (const event of parentEvents) input.onEvent?.(event)
              return { turnId: input.turnId, status: "completed" as const, events: parentEvents }
            })
          },
          follow: (executionId, _afterCursor, onEvent) => {
            if (!executionId.includes(":child:"))
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            const events = executionId === childId ? childEvents : nestedEvents
            return Ref.update(followed, (values) => [...values, executionId]).pipe(
              Effect.tap(() => Effect.sync(() => events.forEach((event) => onEvent?.(event)))),
              Effect.as({ turnId: executionId, status: "completed" as const, events }),
            )
          },
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
          ["parent-turn", "parent-done"],
          [childId, "child-tool"],
          [childId, "nested-spawn"],
          [childId, "child-done"],
          [nestedId, "nested-tool"],
          [nestedId, "nested-done"],
        ])

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
                data: { child_execution_id: `execution:${childId}` },
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
          inspect: () => Effect.void.pipe(Effect.as(undefined)),
          cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled" as const, events: [] }),
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
