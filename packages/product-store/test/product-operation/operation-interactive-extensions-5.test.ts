import { describe, expect, it } from "@effect/vitest"
import {
  ThreadRepository,
  Thread,
  TurnRepository,
  Turn,
  ExecutionBackend,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Ref,
  Operation,
  baseBackend,
  thread,
  interactiveLayer,
  awaitCondition,
  settle,
} from "./operation-interactive-extensions-support"

describe("interactive session extensions", () => {
  it.effect("resumes a child after an actionable wait from its exact last cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const childId = "child:execution%3Aparent-turn:worker"
        const childFollows = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const childFollowCount = yield* Ref.make(0)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Effect.sync(() => {
              input.onEvent?.({
                executionId: input.turnId,
                cursor: "spawn",
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
            }),
          follow: (executionId, afterCursor, onEvent) => {
            const cursor = typeof afterCursor === "string" ? afterCursor : afterCursor?.cursor
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            const waiting: ExecutionBackend.Event = {
              executionId,
              cursor: "wait",
              sequence: 1,
              type: "wait.created",
              createdAt: 2,
              timestampSource: "server",
              data: { wait_id: "wait-child", mode: "external_input" },
            }
            const completed: ReadonlyArray<ExecutionBackend.Event> = [
              {
                executionId,
                cursor: "wake",
                sequence: 2,
                type: "wait.woken",
                createdAt: 3,
                timestampSource: "server",
              },
              {
                executionId,
                cursor: "answer",
                sequence: 3,
                type: "model.output.delta",
                createdAt: 4,
                text: "resumed",
              },
              {
                executionId,
                cursor: "done",
                sequence: 4,
                type: "execution.completed",
                createdAt: 5,
                timestampSource: "server",
              },
            ]
            return Ref.update(childFollows, (cursors) => [...cursors, cursor]).pipe(
              Effect.andThen(Ref.getAndUpdate(childFollowCount, (count) => count + 1)),
              Effect.flatMap((count) => {
                const events =
                  count === 0
                    ? [
                        {
                          executionId,
                          cursor: "started",
                          sequence: 0,
                          type: "execution.started" as const,
                          createdAt: 1,
                          timestampSource: "server",
                        },
                        waiting,
                      ]
                    : completed
                return Effect.sync(() => events.forEach((event) => onEvent?.(event))).pipe(
                  Effect.as({
                    turnId: executionId,
                    status: count === 0 ? ("waiting" as const) : ("completed" as const),
                    events,
                  }),
                )
              }),
            )
          },
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: executionId === "parent-turn" ? [{ executionId: childId, status: "running" as const }] : [],
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
              event.origin.cursor === "wait",
          )
        )
          yield* Effect.yieldNow
        while (
          !events.some(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "done",
          )
        )
          yield* Effect.yieldNow

        expect(yield* Ref.get(childFollows)).toEqual([undefined, "wait"])
        const childCursors = events.flatMap((event) =>
          event._tag === "TranscriptProjectionPatched" &&
          event.origin._tag === "Event" &&
          event.origin.executionId === childId
            ? [event.origin.cursor]
            : [],
        )
        expect(childCursors).toEqual(["started", "wait", "wake", "answer", "done"])

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect(
    "stops child follows on cancel and shutdown but keeps them across selection and session close",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const first = thread("first")
          const second = thread("second")
          const repository = yield* ThreadRepository.makeMemory([first, second])
          const turns = yield* TurnRepository.makeMemory()
          const registration = yield* Deferred.make<Operation.InteractiveSession>()
          const followed = yield* Queue.unbounded<{ readonly executionId: string; readonly afterCursor?: string }>()
          const stopped = yield* Queue.unbounded<string>()
          const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
          const turnSequence = yield* Ref.make(0)
          const backend = ExecutionBackend.Service.of({
            ...baseBackend,
            start: (input) => {
              const childId = `${input.turnId}:child:worker`
              return Effect.sync(() => {
                input.onEvent?.({
                  executionId: input.turnId,
                  cursor: "spawn",
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
            follow: (executionId, afterCursor, onEvent) =>
              executionId.includes(":child:")
                ? Queue.offer(followed, {
                    executionId,
                    ...(afterCursor === undefined
                      ? {}
                      : { afterCursor: typeof afterCursor === "string" ? afterCursor : afterCursor.cursor }),
                  }).pipe(
                    Effect.tap(() =>
                      afterCursor === undefined
                        ? Effect.sync(() =>
                            onEvent?.({
                              executionId,
                              cursor: "working",
                              sequence: 0,
                              type: "model.output.delta",
                              createdAt: 2,
                              text: "working",
                            }),
                          )
                        : Effect.void,
                    ),
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Queue.offer(stopped, executionId)),
                  )
                : Effect.succeed({ turnId: executionId, status: "running" as const, events: [] }),
            inspect: (turnId) =>
              Ref.get(cancelled).pipe(
                Effect.map((values) => {
                  const childId = `${turnId}:child:worker`
                  const rootId = turnId.split(":child:")[0]!
                  const terminal = values.includes(turnId) || values.includes(rootId)
                  return {
                    turnId,
                    status: terminal ? ("cancelled" as const) : ("running" as const),
                    waits: [],
                    pendingTools: [],
                    children: turnId.includes(":child:")
                      ? []
                      : [
                          {
                            executionId: childId,
                            status:
                              terminal || values.includes(childId) ? ("cancelled" as const) : ("running" as const),
                          },
                        ],
                  }
                }),
              ),
            cancel: (turnId) => {
              const events: ReadonlyArray<ExecutionBackend.Event> = turnId.includes(":child:")
                ? [
                    {
                      executionId: turnId,
                      cursor: "working",
                      sequence: 0,
                      type: "model.output.delta",
                      createdAt: 2,
                      text: "working",
                    },
                    {
                      executionId: turnId,
                      cursor: "stopped",
                      sequence: 1,
                      type: "execution.cancelled",
                      createdAt: 3,
                    },
                  ]
                : []
              return Ref.update(cancelled, (values) => [...values, turnId]).pipe(
                Effect.as({ turnId, status: "cancelled" as const, events }),
              )
            },
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
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(layer)
              const operation = Context.get(context, Operation.Service)
              const operationFiber = yield* Effect.forkChild(
                operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
              )
              const session = yield* Deferred.await(registration)
              const events: Array<Operation.InteractiveEvent> = []
              const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
              yield* session.selectThread(first.id, 1)

              yield* session.submit("cancelled")
              expect(yield* Queue.take(followed)).toEqual({ executionId: "turn-1:child:worker" })
              yield* session.cancel
              expect(yield* Queue.take(stopped)).toBe("turn-1:child:worker")
              expect(new Set(yield* Ref.get(cancelled))).toEqual(new Set(["turn-1"]))
              expect(
                events.flatMap((event) =>
                  event._tag === "TranscriptProjectionPatched" &&
                  event.origin._tag === "Event" &&
                  event.origin.executionId === "turn-1:child:worker"
                    ? [event.origin.cursor]
                    : [],
                ),
              ).toEqual(["working"])

              yield* session.submit("selected away")
              expect(yield* Queue.take(followed)).toEqual({ executionId: "turn-2:child:worker" })
              yield* session.selectThread(second.id, 2)
              yield* settle()
              expect(yield* Queue.size(stopped)).toBe(0)
              expect(yield* Queue.size(followed)).toBe(0)

              yield* Fiber.interrupt(feed)
              yield* Fiber.interrupt(operationFiber)
              yield* settle()
              expect(yield* Queue.size(stopped)).toBe(0)
            }),
          )

          expect(yield* awaitCondition(Effect.map(Queue.size(stopped), (size) => size > 0))).toBe(true)
          expect(new Set(yield* Queue.clear(stopped))).toEqual(new Set(["turn-2:child:worker"]))
        }),
      ),
    120_000,
  )
})
