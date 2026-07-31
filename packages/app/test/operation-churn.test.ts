import { expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect"
import { Operation } from "../src/index"

type Client = {
  readonly session: Operation.InteractiveSession
  readonly fiber: Fiber.Fiber<void, Operation.OperationUnavailable>
  readonly events: Array<Operation.InteractiveEvent>
  readonly selected: Queue.Queue<void>
}

const patchSequences = (client: Client) =>
  client.events.flatMap((event) =>
    event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event" && event.origin.sequence > 2
      ? [event.origin.sequence - 3]
      : [],
  )

it.effect("delivers each joined subscriber suffix exactly once through subscribe and unsubscribe churn", () =>
  Effect.gen(function* () {
    const thread: Thread.Thread = {
      id: Thread.ThreadId.make("churn-thread"),
      workspace: "/work",
      title: "Churn",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt: 1,
    }
    const releases = yield* Queue.unbounded<void>()
    const started = yield* Deferred.make<void>()
    const following = yield* Deferred.make<void>()
    const liveEvents = yield* Queue.unbounded<ExecutionBackend.Event>()
    const emitted: Array<ExecutionBackend.Event> = []
    const lifecycleEvents: ReadonlyArray<ExecutionBackend.Event> = [
      {
        executionId: "execution:churn-turn",
        cursor: "churn-accepted",
        sequence: 1,
        type: "execution.accepted",
        createdAt: 1,
        timestampSource: "server",
      },
      {
        executionId: "execution:churn-turn",
        cursor: "churn-started",
        sequence: 2,
        type: "execution.started",
        createdAt: 2,
        timestampSource: "server",
      },
    ]
    const streamed: ReadonlyArray<ExecutionBackend.Event> = Array.from({ length: 8 }, (_, index) => ({
      executionId: "execution:churn-turn",
      cursor: `churn-${index}`,
      sequence: index + 3,
      type: index === 7 ? "execution.completed" : "model.output.delta",
      createdAt: index + 3,
      timestampSource: "server",
      ...(index === 7 ? {} : { text: String(index) }),
    }))
    let running = false
    const backend = ExecutionBackend.Service.of({
      invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
      createFanOut: () => Effect.die("unused"),
      inspectFanOut: () => Effect.die("unused"),
      cancelFanOut: () => Effect.die("unused"),
      registerWorkflows: () => Effect.die("unused"),
      startWorkflow: () => Effect.die("unused"),
      inspectWorkflow: () => Effect.die("unused"),
      cancelWorkflow: () => Effect.die("unused"),
      start: (input) =>
        Effect.gen(function* () {
          running = true
          yield* Deferred.succeed(started, undefined)
          for (const event of streamed) {
            yield* Queue.take(releases)
            emitted.push(event)
            yield* Queue.offer(liveEvents, event)
          }
          running = false
          return { turnId: input.turnId, status: "completed" as const, events: streamed }
        }),
      follow: (turnId, _afterCursor, onEvent) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(following, undefined)
          const events: Array<ExecutionBackend.Event> = [...lifecycleEvents]
          for (const event of lifecycleEvents) {
            emitted.push(event)
            onEvent?.(event)
          }
          while (events.length < streamed.length + lifecycleEvents.length) {
            const event = yield* Queue.take(liveEvents)
            events.push(event)
            onEvent?.(event)
          }
          return { turnId, status: "completed" as const, events }
        }),
      replay: (turnId) =>
        Effect.succeed({
          turnId,
          status: running ? ("running" as const) : ("completed" as const),
          events: [...emitted],
        }),
      cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled" as const, events: [] }),
      inspect: (turnId) =>
        Effect.succeed(
          running ? { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] } : undefined,
        ),
      steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
      resolveInvocationSource: () => Effect.die("unused"),
    })
    const registrations = yield* Queue.unbounded<{
      readonly session: Operation.InteractiveSession
      readonly events: Array<Operation.InteractiveEvent>
      readonly selected: Queue.Queue<void>
    }>()
    const layer = Operation.productLayer({
      repositoryLayer: ThreadRepository.memoryLayer([thread]),
      turnRepositoryLayer: TurnRepository.memoryLayer(),
      backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
      defaultWorkspace: "/work",
      makeThreadId: Effect.die("unused"),
      makeTurnId: Effect.succeed(Turn.TurnId.make("churn-turn")),
      interactive: (_, session) =>
        Effect.gen(function* () {
          const events: Array<Operation.InteractiveEvent> = []
          const selected = yield* Queue.unbounded<void>()
          yield* Queue.offer(registrations, { session, events, selected })
          yield* session.events((event) => {
            events.push(event)
            if (event._tag === "SelectionLoaded") Queue.offerUnsafe(selected, undefined)
          })
        }),
    })
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          const open = Effect.fn("OperationChurnTest.open")(function* (select: boolean) {
            const fiber = yield* Effect.forkChild(
              operation.run({
                _tag: "Interactive",
                prompt: [],
                threadId: thread.id,
                ephemeral: false,
              }),
            )
            const registration = yield* Queue.take(registrations)
            const client = { ...registration, fiber }
            if (select) {
              yield* client.session.selectThread(thread.id, 1)
              yield* Queue.take(client.selected)
            }
            return client
          })
          const release = Effect.fn("OperationChurnTest.release")(function* (sequence: number, source: Client) {
            yield* Queue.offer(releases, undefined)
            for (let attempt = 0; attempt < 4_000; attempt += 1) {
              if (patchSequences(source).includes(sequence)) return
              yield* Effect.yieldNow
            }
            const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
              source.events.map((event) => {
                if (event._tag === "TranscriptProjectionFailed") {
                  return {
                    tag: event._tag,
                    executionId: event.executionId,
                    reason: event.reason,
                    message: event.message,
                  }
                }
                if (event._tag === "TranscriptProjectionPatched") {
                  return { tag: event._tag, origin: event.origin }
                }
                return { tag: event._tag }
              }),
            )
            return yield* Effect.die(`Projection sequence ${sequence} was not published: ${encoded}`)
          })

          const initial = yield* Effect.forEach(Array.from({ length: 4 }), () => open(true), { concurrency: 1 })
          const source = initial[0]!
          yield* Effect.forkChild(
            operation.run({
              _tag: "Run",
              prompt: ["stream"],
              threadId: thread.id,
              ephemeral: false,
              streamJson: false,
              streamJsonInput: false,
              streamJsonThinking: false,
            }),
          )
          yield* Deferred.await(started)
          yield* Deferred.await(following)
          yield* release(0, source)
          yield* release(1, source)

          const firstWave = yield* Effect.forEach(Array.from({ length: 4 }), () => open(false), { concurrency: 1 })
          yield* release(2, source)
          yield* Effect.forEach(
            firstWave,
            (client) => client.session.selectThread(thread.id, 1).pipe(Effect.andThen(Queue.take(client.selected))),
            { concurrency: 4, discard: true },
          )
          yield* release(3, source)
          yield* Effect.forEach(
            [initial[1]!, initial[2]!, firstWave[0]!, firstWave[1]!],
            (client) => Fiber.interrupt(client.fiber),
            {
              concurrency: 4,
              discard: true,
            },
          )

          const secondWave = yield* Effect.forEach(Array.from({ length: 4 }), () => open(false), { concurrency: 1 })
          yield* release(4, source)
          yield* Effect.forEach(
            secondWave,
            (client) => client.session.selectThread(thread.id, 1).pipe(Effect.andThen(Queue.take(client.selected))),
            { concurrency: 4, discard: true },
          )
          yield* Effect.forEach([secondWave[0]!, secondWave[1]!], (client) => Fiber.interrupt(client.fiber), {
            concurrency: 2,
            discard: true,
          })
          yield* release(5, source)
          yield* release(6, source)
          yield* release(7, source)

          const survivors = [source, initial[3]!, firstWave[2]!, firstWave[3]!, secondWave[2]!, secondWave[3]!]
          const expected = [
            [0, 1, 2, 3, 4, 5, 6, 7],
            [0, 1, 2, 3, 4, 5, 6, 7],
            [3, 4, 5, 6, 7],
            [3, 4, 5, 6, 7],
            [5, 6, 7],
            [5, 6, 7],
          ]
          for (const [index, client] of survivors.entries()) expect(patchSequences(client)).toEqual(expected[index])
          for (const client of [source, initial[3]!]) {
            const startedEvents = client.events.filter(
              (event) => event._tag === "TurnStarted" && event.turn.id === Turn.TurnId.make("churn-turn"),
            )
            expect(startedEvents).toHaveLength(1)
            expect(client.events.indexOf(startedEvents[0]!)).toBeLessThan(
              client.events.findIndex(
                (event) =>
                  event._tag === "TranscriptProjectionPatched" &&
                  event.origin._tag === "Event" &&
                  event.origin.sequence === 3,
              ),
            )
          }
        }).pipe(Effect.provide(context))
      }),
    )
  }),
)
