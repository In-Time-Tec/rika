import { expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Layer, Queue, Ref } from "effect"
import { Operation } from "../src/index"
import { executionRoute } from "./current-state"

const busyThreadId = Thread.ThreadId.make("busy-thread")
const openThreadId = Thread.ThreadId.make("open-thread")
const busyTurnId = Turn.TurnId.make("busy-turn")
const openTurnId = Turn.TurnId.make("open-turn")
const selectionRepairPageLimit = 32

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
    executionId: `execution:${turnId}`,
    cursor: `${prefix}-0`,
    sequence: 0,
    type: "model.output.completed",
    createdAt: 0,
    text: prefix,
  },
  { executionId: `execution:${turnId}`, cursor: `${prefix}-1`, sequence: 1, type: "execution.completed", createdAt: 1 },
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
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.void,
  resolvePermission: () => Effect.void,
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
}

const runHarness = <A, E, R>(
  backend: ExecutionBackend.Interface,
  initialTurns: ReadonlyArray<Turn.Turn>,
  body: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const turns = yield* TurnRepository.makeMemory(initialTurns)
    const registrations = yield* Queue.unbounded<{
      readonly session: Operation.InteractiveSession
      readonly events: Array<Operation.InteractiveEvent>
    }>()
    const layer = Operation.productLayer({
      repositoryLayer: ThreadRepository.memoryLayer([thread(busyThreadId), thread(openThreadId)]),
      turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
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
          return yield* body({ ...(yield* Queue.take(registrations)), turns })
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

it.effect("stops a reclaim backfill at the selection repair page budget", () =>
  Effect.gen(function* () {
    const children = Array.from({ length: 200 }, (_, index) => ({
      executionId: `busy-child-${index}`,
      status: "completed" as const,
    }))
    const overBudgetChild = `busy-child-${selectionRepairPageLimit}`
    const started = yield* Ref.make(false)
    const childReplays = yield* Ref.make(0)
    const overBudgetReplayed = yield* Ref.make(false)
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
          if (turnId === String(busyTurnId)) return (yield* Ref.get(started)) ? inspection(turnId, children) : undefined
          if (turnId.startsWith("busy-child-")) return inspection(turnId, [])
          return undefined
        }),
      replay: (turnId) =>
        Effect.gen(function* () {
          if (turnId.startsWith("busy-child-")) {
            yield* Ref.update(childReplays, (count) => count + 1)
            if (turnId === overBudgetChild) yield* Ref.set(overBudgetReplayed, true)
          }
          return { turnId, status: "completed" as const, events: completedEvents(turnId, turnId) }
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
        expect(yield* awaitCondition(Ref.get(overBudgetReplayed))).toBe(false)
        expect(yield* Ref.get(childReplays)).toBe(selectionRepairPageLimit)
        expect(client.events.some((event) => event._tag === "ExecutionFailed")).toBe(false)
      }),
    )
  }),
)
