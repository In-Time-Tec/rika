import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import type { Interface as TurnRepositoryInterface } from "@rika/product/turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import * as Scope from "effect/Scope"

import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend, projectionSnapshot } from "../support/operation-execution-fixtures"
import { threadLineage } from "../support/operation-selection-fixtures"

const drainThread = (): Thread.Thread => ({
  id: Thread.ThreadId.make("drain-thread"),
  lineage: threadLineage,
  workspace: "/work",
  title: "Drain",
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

const waitForStatus = (
  turns: TurnRepositoryInterface,
  id: string,
  status: ExecutionStatus.Status,
  attempts = 5000,
): Effect.Effect<boolean, import("@rika/product/turn-repository").RepositoryError, never> =>
  Effect.gen(function* () {
    let waited = 0
    while (waited < attempts && (yield* turns.get(Turn.TurnId.make(id)))?.status !== status) {
      yield* Effect.yieldNow
      waited += 1
    }
    return waited < attempts
  })

const openSession = (
  sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>,
  dispatch: (event: InteractiveEvent) => void,
): Effect.Effect<InteractiveSession, never, Scope.Scope | import("@rika/product/product-operation-service").Service> =>
  Effect.gen(function* () {
    const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
    yield* Effect.forkChild(session.events(dispatch))
    yield* Effect.yieldNow
    return session
  })

describe("Operation queue drain", () => {
  it.effect("promotes queued turns after a directly submitted turn fails", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const turnSequence = yield* Ref.make(0)
      const thread = drainThread()
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory()
      const failFirst = yield* Deferred.make<void>()
      const failingBackend = ExecutionGateway.Service.of({
        ...backend,
        watchTurn: (link) =>
          link.turnId === "turn-1"
            ? Stream.concat(
                Stream.make(projectionSnapshot(link.turnId, "running", "turn-1-running")),
                Stream.fromEffect(Deferred.await(failFirst)).pipe(
                  Stream.flatMap(() =>
                    Stream.fail(
                      ExecutionGateway.WatchTurnFailure.make({
                        message: "The model provider rate-limited the request. Wait a moment, then try again.",
                      }),
                    ),
                  ),
                ),
              )
            : backend.watchTurn(link),
      })
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, failingBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 64,
        makeThreadId: Effect.die("unused"),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openSession(sessions, dispatch)
        yield* session.selectThread(thread.id)
        yield* session.submit("first")
        yield* waitForStatus(turns, "turn-1", "running")
        yield* session.submit("second")
        yield* session.submit("third")
        while ((yield* turns.readQueue(thread.id)).queuedCount !== 2) yield* Effect.yieldNow
        yield* Deferred.succeed(failFirst, undefined)
        yield* waitForStatus(turns, "turn-3", "completed")
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* turns.get(Turn.TurnId.make("turn-1"))).toMatchObject({ status: "failed" })
      expect(yield* turns.get(Turn.TurnId.make("turn-2"))).toMatchObject({ status: "completed" })
      expect(yield* turns.get(Turn.TurnId.make("turn-3"))).toMatchObject({ status: "completed" })
    }),
  )

  it.effect("keeps draining when a promoted queued turn fails", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const turnSequence = yield* Ref.make(0)
      const thread = drainThread()
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory()
      const completeFirst = yield* Deferred.make<void>()
      const failingBackend = ExecutionGateway.Service.of({
        ...backend,
        watchTurn: (link) => {
          if (link.turnId === "turn-1")
            return Stream.concat(
              Stream.make(projectionSnapshot(link.turnId, "running", "turn-1-running")),
              Stream.fromEffect(Deferred.await(completeFirst)).pipe(
                Stream.map(() => projectionSnapshot(link.turnId, "completed", "turn-1-completed")),
              ),
            )
          if (link.turnId === "turn-2") return Stream.make(projectionSnapshot(link.turnId, "failed", "turn-2-failed"))
          return backend.watchTurn(link)
        },
      })
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, failingBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 64,
        makeThreadId: Effect.die("unused"),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openSession(sessions, dispatch)
        yield* session.selectThread(thread.id)
        yield* session.submit("first")
        yield* waitForStatus(turns, "turn-1", "running")
        yield* session.submit("second")
        yield* session.submit("third")
        while ((yield* turns.readQueue(thread.id)).queuedCount !== 2) yield* Effect.yieldNow
        yield* Deferred.succeed(completeFirst, undefined)
        yield* waitForStatus(turns, "turn-2", "failed")
        yield* waitForStatus(turns, "turn-3", "completed")
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* turns.get(Turn.TurnId.make("turn-1"))).toMatchObject({ status: "completed" })
      expect(yield* turns.get(Turn.TurnId.make("turn-2"))).toMatchObject({ status: "failed" })
      expect(yield* turns.get(Turn.TurnId.make("turn-3"))).toMatchObject({ status: "completed" })
    }),
  )
})
