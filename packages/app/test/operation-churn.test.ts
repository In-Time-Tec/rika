import { expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Fiber, Layer, Queue } from "effect"
import { Operation } from "../src/index"

type Client = {
  readonly session: Operation.InteractiveSession
  readonly fiber: Fiber.Fiber<void, Operation.OperationUnavailable>
  readonly events: Array<Operation.InteractiveEvent>
  readonly selected: Queue.Queue<void>
}

const patchSequences = (client: Client) =>
  client.events.flatMap((event) => (event._tag === "TranscriptPatched" ? [event.event.sequence] : []))

it.effect("delivers each joined subscriber suffix exactly once through subscribe and unsubscribe churn", () =>
  Effect.gen(function* () {
    const thread: Thread.Thread = {
      id: Thread.ThreadId.make("churn-thread"),
      workspace: "/work",
      title: "Churn",
      labels: [],
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    }
    const releases = yield* Queue.unbounded<void>()
    const started = yield* Deferred.make<void>()
    const following = yield* Deferred.make<void>()
    const liveEvents = yield* Queue.unbounded<ExecutionBackend.Event>()
    const emitted: Array<ExecutionBackend.Event> = []
    const streamed: ReadonlyArray<ExecutionBackend.Event> = Array.from({ length: 8 }, (_, sequence) => ({
      cursor: `churn-${sequence}`,
      sequence,
      type: sequence === 7 ? "execution.completed" : "model.output.delta",
      createdAt: sequence,
      ...(sequence === 7 ? {} : { text: String(sequence) }),
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
          const events: Array<ExecutionBackend.Event> = []
          while (events.length < streamed.length) {
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
      listApprovals: () => Effect.succeed([]),
      resolveToolApproval: () => Effect.void,
      resolvePermission: () => Effect.void,
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
            while (!patchSequences(source).includes(sequence)) yield* Effect.yieldNow
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
            [2, 3, 4, 5, 6, 7],
            [2, 3, 4, 5, 6, 7],
            [4, 5, 6, 7],
            [4, 5, 6, 7],
          ]
          for (const [index, client] of survivors.entries()) expect(patchSequences(client)).toEqual(expected[index])
          for (const client of [source, initial[3]!]) {
            const startedEvents = client.events.filter(
              (event) => event._tag === "TurnStarted" && event.turn.id === Turn.TurnId.make("churn-turn"),
            )
            expect(startedEvents).toHaveLength(1)
            expect(client.events.indexOf(startedEvents[0]!)).toBeLessThan(
              client.events.findIndex((event) => event._tag === "TranscriptPatched" && event.event.sequence === 0),
            )
          }
        }).pipe(Effect.provide(context))
      }),
    )
  }),
)
