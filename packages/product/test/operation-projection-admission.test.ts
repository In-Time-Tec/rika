import { expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import { Context, Deferred, Effect, Layer, Queue, Ref, Schema } from "effect"
import { Operation } from "@rika/product/product-operation"
import { executionRoute } from "./current-state"

const busyThreadId = Thread.ThreadId.make("busy-thread")
const openThreadId = Thread.ThreadId.make("open-thread")
const busyTurnId = Turn.TurnId.make("busy-turn")
const openTurnId = Turn.TurnId.make("open-turn")

const thread = (id: Thread.ThreadId): Thread.Thread => ({
  id,
  workspace: "/work",
  title: String(id),
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
})

const openTurn: Turn.Turn = {
  _tag: "AgentExecution",
  id: openTurnId,
  threadId: openThreadId,
  prompt: "opened",
  executionRoute: executionRoute(),
  status: "completed",
  stopIntent: "none",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}

const completedEvents = (prefix: string, turnId: string): ReadonlyArray<ExecutionBackend.Event> => [
  {
    executionId: turnId,
    cursor: `${prefix}-0`,
    sequence: 0,
    type: "execution.started",
    createdAt: 0,
    timestampSource: "server",
  },
  {
    executionId: turnId,
    cursor: `${prefix}-1`,
    sequence: 1,
    type: "model.output.completed",
    createdAt: 1,
    text: prefix,
  },
  {
    executionId: turnId,
    cursor: `${prefix}-2`,
    sequence: 2,
    type: "execution.completed",
    createdAt: 2,
    timestampSource: "server",
  },
]

const inspection = (
  turnId: string,
  children: ReadonlyArray<{ readonly executionId: string; readonly status: ExecutionBackend.Status }>,
): ExecutionBackend.Inspection => ({ turnId, status: "completed", waits: [], pendingTools: [], children })

const idleBackend = {
  invokeChild: (input: ExecutionBackend.InvokeChildInput) => Effect.succeed({ ...input, type: "accepted" as const }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  cancel: (turnId: string) => Effect.succeed({ turnId, status: "cancelled" as const, events: [] }),
  steer: (turnId: string) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
  resolveInvocationSource: () => Effect.die("unused"),
}

const settleCeiling = 4_000

const awaitCondition = <E>(condition: Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < settleCeiling; attempt += 1) {
      if (yield* condition) return true
      yield* Effect.yieldNow
    }
    return yield* condition
  })

const selectionLoaded = (events: ReadonlyArray<Operation.InteractiveEvent>, threadId: Thread.ThreadId) =>
  Effect.sync(() => events.some((event) => event._tag === "SelectionLoaded" && event.thread.id === threadId))

type Client = {
  readonly session: Operation.InteractiveSession
  readonly events: Array<Operation.InteractiveEvent>
  readonly turns: TurnRepository.Interface
  readonly usage: UsageRepository.Interface
}

const runHarness = <A, E, R>(
  backend: ExecutionBackend.Interface,
  initialTurns: ReadonlyArray<Turn.Turn>,
  body: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const turns = yield* TurnRepository.makeMemory(initialTurns)
    const usage = Context.get(yield* Layer.build(UsageRepository.memoryLayer), UsageRepository.Service)
    const registrations = yield* Queue.unbounded<{
      readonly session: Operation.InteractiveSession
      readonly events: Array<Operation.InteractiveEvent>
    }>()
    const layer = Operation.productLayer({
      repositoryLayer: ThreadRepository.memoryLayer([thread(busyThreadId), thread(openThreadId)]),
      turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
      usageRepositoryLayer: Layer.succeed(UsageRepository.Service, usage),
      backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
      defaultWorkspace: "/work",
      makeThreadId: Effect.die("unused"),
      makeTurnId: Effect.succeed(busyTurnId),
      interactive: (_, session) =>
        Effect.gen(function* () {
          const events: Array<Operation.InteractiveEvent> = []
          yield* Queue.offer(registrations, { session, events })
          yield* session.events((event) => events.push(event))
        }),
    })
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
          return yield* body({ ...(yield* Queue.take(registrations)), turns, usage })
        }).pipe(Effect.provide(context))
      }),
    )
  })

it.effect("loads an interactive thread while a background projection holds another turn's admission", () => {
  const busyChildId = "busy-child"
  return Effect.gen(function* () {
    const started = yield* Ref.make(false)
    const backfillEntered = yield* Deferred.make<void>()
    const releaseBackfill = yield* Deferred.make<void>()
    const backfillCompleted = yield* Ref.make(false)
    const backend = ExecutionBackend.Service.of({
      ...idleBackend,
      start: (input) =>
        Ref.set(started, true).pipe(
          Effect.as({
            turnId: input.turnId,
            status: "completed" as const,
            events: completedEvents("busy", input.turnId),
          }),
        ),
      inspect: (turnId) =>
        Effect.gen(function* () {
          if (turnId === String(busyTurnId))
            return (yield* Ref.get(started))
              ? inspection(turnId, [{ executionId: busyChildId, status: "completed" }])
              : undefined
          if (turnId === busyChildId || turnId === String(openTurnId)) return inspection(turnId, [])
          return undefined
        }),
      replay: (turnId) =>
        Effect.gen(function* () {
          if (turnId === busyChildId) {
            yield* Deferred.succeed(backfillEntered, undefined)
            yield* Deferred.await(releaseBackfill)
            yield* Ref.set(backfillCompleted, true)
          }
          return { turnId, status: "completed" as const, events: completedEvents(turnId, turnId) }
        }),
    })
    yield* runHarness(backend, [openTurn], (client) =>
      Effect.gen(function* () {
        yield* client.session.selectThread(busyThreadId, 1)
        expect(yield* awaitCondition(selectionLoaded(client.events, busyThreadId))).toBe(true)

        yield* client.session.submit("busy")
        yield* Deferred.await(backfillEntered)
        expect(yield* Ref.get(backfillCompleted)).toBe(false)

        yield* client.session.selectThread(openThreadId, 2)
        expect(yield* awaitCondition(selectionLoaded(client.events, openThreadId))).toBe(true)
        expect(yield* Ref.get(backfillCompleted)).toBe(false)

        yield* Deferred.succeed(releaseBackfill, undefined)
        expect(yield* awaitCondition(Ref.get(backfillCompleted))).toBe(true)
      }),
    )
  })
})

const pricedEvents = (
  turnId: string,
  children: ReadonlyArray<{ readonly executionId: string }> = [],
): ReadonlyArray<ExecutionBackend.Event> => {
  const delegation = children.flatMap((child, index): ReadonlyArray<ExecutionBackend.Event> => {
    const sequence = index * 2 + 2
    const callId = `busy-call-${index}`
    return [
      {
        executionId: turnId,
        cursor: `${callId}-requested`,
        sequence,
        type: "tool.call.requested",
        createdAt: sequence,
        data: { tool_call_id: callId, tool_name: "task", input: { prompt: child.executionId } },
      },
      {
        executionId: turnId,
        cursor: `${callId}-spawned`,
        sequence: sequence + 1,
        type: "child_run.spawned",
        createdAt: sequence + 1,
        childExecutionId: child.executionId,
        data: { tool_call_id: callId, child_execution_id: child.executionId },
      },
    ]
  })
  const terminalSequence = delegation.length + 2
  return [
    {
      executionId: turnId,
      cursor: "priced-started",
      sequence: 0,
      type: "execution.started",
      createdAt: 0,
      timestampSource: "server",
    },
    {
      executionId: turnId,
      cursor: "priced-usage",
      sequence: 1,
      type: "model.attempt.completed",
      createdAt: 1,
      data: {
        model_call_id: "priced-call",
        model_attempt_id: "priced-attempt",
        attempt: 1,
        cost: { amount: 0.25, currency: "USD" },
      },
    },
    ...delegation,
    {
      executionId: turnId,
      cursor: "priced-done",
      sequence: terminalSequence,
      type: "execution.completed",
      createdAt: terminalSequence,
      timestampSource: "server",
    },
  ]
}

it.effect("reads every child once under the bounded selection repair and keeps committed usage exact", () =>
  Effect.gen(function* () {
    const children = Array.from({ length: 200 }, (_, index) => ({
      executionId: `busy-child-${index}`,
      status: "completed" as const,
    }))
    const started = yield* Ref.make(false)
    const childReads = yield* Ref.make(new Map<string, number>())
    const countRead = (turnId: string) =>
      Ref.update(childReads, (counts) => new Map(counts).set(turnId, (counts.get(turnId) ?? 0) + 1))
    const backend = ExecutionBackend.Service.of({
      ...idleBackend,
      start: (input) =>
        Ref.set(started, true).pipe(
          Effect.as({
            turnId: input.turnId,
            status: "completed" as const,
            events: pricedEvents(input.turnId, children),
          }),
        ),
      inspect: (turnId) =>
        Effect.gen(function* () {
          if (turnId === String(busyTurnId)) return (yield* Ref.get(started)) ? inspection(turnId, children) : undefined
          if (turnId.startsWith("busy-child-")) return inspection(turnId, [])
          return undefined
        }),
      replay: (turnId) =>
        Effect.gen(function* () {
          if (turnId.startsWith("busy-child-")) yield* countRead(turnId)
          return {
            turnId,
            status: "completed" as const,
            events:
              turnId === String(busyTurnId) || turnId === `execution:${busyTurnId}`
                ? pricedEvents(turnId, children)
                : completedEvents(turnId, turnId),
          }
        }),
    })
    yield* runHarness(backend, [], (client) =>
      Effect.gen(function* () {
        yield* client.session.selectThread(busyThreadId, 1)
        expect(yield* awaitCondition(selectionLoaded(client.events, busyThreadId))).toBe(true)

        yield* client.session.submit("busy")
        expect(
          yield* awaitCondition(client.turns.get(busyTurnId).pipe(Effect.map((turn) => turn?.status === "completed"))),
        ).toBe(true)
        expect(
          yield* awaitCondition(Ref.get(childReads).pipe(Effect.map((counts) => counts.size === children.length))),
        ).toBe(true)

        const counts = yield* Ref.get(childReads)
        expect([...counts.values()].every((count) => count === 1)).toBe(true)
        expect(client.events.some((event) => event._tag === "ExecutionFailed")).toBe(false)
        const complete = yield* awaitCondition(
          client.usage
            .readSource(String(busyTurnId), String(busyTurnId))
            .pipe(Effect.map((source) => source?.sourceComplete === true)),
        )
        const debug = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
          source: yield* client.usage.readSource(String(busyTurnId), String(busyTurnId)),
          failures: client.events.filter(
            (event) => event._tag === "ExecutionFailed" || event._tag === "TranscriptProjectionFailed",
          ),
        })
        expect(complete, debug).toBe(true)
        expect((yield* client.usage.readThread(String(busyThreadId))).costNanoUsd).toBe(250_000_000)
      }),
    )
  }),
)
