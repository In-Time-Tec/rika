import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"

import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { collectEvents, holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend, inspectTurnFromTurns } from "../support/operation-execution-fixtures"
import { turnProvenance, threadLineage, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("restores a queued prompt when steering the active turn fails", () =>
    Effect.gen(function* () {
      const thread = selectionThread("steer-failure-thread")
      const queuedId = Turn.TurnId.make("steer-failure-queued")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("steer-failure-active"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: {
            runId: "steer-failure-run",
            turnId: "steer-failure-active",
            threadId: String(thread.id),
          },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: queuedId,
          ...turnProvenance,
          threadId: thread.id,
          prompt: "keep this prompt",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("steer-failure-later"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "later prompt",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const failingBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: () => Effect.succeed({ status: "running" }),
        watchTurn: () => Stream.never,
        steerTurn: () => Effect.fail(ExecutionGateway.SteeringFailure.make({ message: "forced steer failure" })),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const received: Array<InteractiveEvent> = []

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* collectEvents(session, received)
        yield* session.selectThread(thread.id, 1)
        received.length = 0
        yield* session.steerQueued(queuedId, "unused fallback")
        yield* settleEvents
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, failingBackend),
            defaultWorkspace: "/work",
            pendingTurnCapacity: 2,
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )

      expect(yield* turns.get(queuedId)).toMatchObject({ status: "queued", prompt: "keep this prompt", createdAt: 2 })
      expect((yield* turns.readQueue(thread.id)).turns.map((turn) => turn.id)).toEqual([
        "steer-failure-queued",
        "steer-failure-later",
      ])
      expect(received).toContainEqual(
        expect.objectContaining({
          _tag: "ExecutionControlFailed",
          message: "Rika could not complete that action. Run rika diagnostics status if it keeps happening.",
        }),
      )
      expect(received.some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("interrupts an active turn and starts the replacement callback", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interrupt-thread"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Interrupt",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active"),
          ...turnProvenance,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          executionLink: { runId: "interrupt-active-run", turnId: "active", threadId: String(thread.id) },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const cancelled = yield* Deferred.make<void>()
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (all) => [...all, event]))))
        yield* Effect.yieldNow
        yield* session.reopenThread(1)
        yield* session.interruptAndSend("replacement prompt")
        yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionGateway.Service, {
              ...backend,
              inspectTurn: inspectTurnFromTurns(turns),
              cancelTurn: () => Deferred.succeed(cancelled, undefined),
              watchTurn: (link) =>
                link.turnId === "active"
                  ? Stream.fromEffect(Deferred.await(cancelled)).pipe(
                      Stream.map(() => ({
                        executionId: link.runId,
                        cursor: "interrupt-cancelled",
                        sequence: 0,
                        type: "execution.cancelled" as const,
                        timestampSource: "baton" as const,
                        createdAt: 2,
                      })),
                    )
                  : backend.watchTurn(link),
            }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("replacement")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({ status: "cancelled" })
      expect(yield* turns.get(Turn.TurnId.make("replacement"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("QueueUpdated")
    }),
  )
})
