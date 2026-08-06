import { OperationUnavailable } from "@rika/product/product-operation"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { it as rawIt } from "vitest"

import { createTurn } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { backend } from "../support/operation-execution-fixtures"

import { threadLineage } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("rejects every action after an interactive session closes", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const writes = yield* Ref.make(0)
      const starts = yield* Ref.make(0)
      const turns = yield* TurnRepository.makeMemory([])
      const repository = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(createTurn(turns, input))),
      })
      const closedBackend = ExecutionGateway.Service.of({
        ...backend,
        startTurn: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.startTurn(input))),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("missing session")
        const actions = [
          session.events(() => undefined),
          session.submit("closed submit"),
          session.shell(undefined, "true", true),
          session.editQueued("turn", "edit"),
          session.dequeue("turn"),
          session.steerQueued("turn", "steer"),
          session.steer("steer"),
          session.interruptAndSend("interrupt"),
          session.cancel,
          session.newThread,
          session.selectThread("thread", 1),
          session.readQueue("thread"),
          session.loadOlder(
            "thread",
            1,
            {
              createdAt: 0,
              turnId: Turn.TurnId.make("turn"),
              orderKey: "turn:user",
            },
            [],
          ),
          session.previewThread("thread"),
          session.reopenThread(1),
        ]
        const results = yield* Effect.forEach(actions, Effect.exit)
        expect(results).toHaveLength(actions.length)
        for (const result of results) {
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(String(result.cause)).toContain("Interactive session is closed")
        }
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, repository),
            backendLayer: Layer.succeed(ExecutionGateway.Service, closedBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("closed-thread")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("closed-turn")),
            interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
          }),
        ),
      )
      expect(yield* Ref.get(writes)).toBe(0)
      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* turns.listNonterminal).toEqual([])
    }),
  )

  rawIt("releases an admitted turn observer when its interactive session closes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const thread: Thread.Thread = {
          id: Thread.ThreadId.make("admitted-thread"),
          lineage: threadLineage,
          workspace: "/work",
          title: "Admitted",
          labels: [],
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
        }
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const submitted = yield* Deferred.make<Fiber.Fiber<void, OperationUnavailable>>()
        const starts = yield* Ref.make(0)
        const turns = yield* TurnRepository.makeMemory([])
        const admittedBackend = ExecutionGateway.Service.of({
          ...backend,
          startTurn: (input) =>
            Ref.update(starts, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(backend.startTurn(input)),
            ),
          watchTurn: (link) =>
            Stream.fromEffect(Deferred.await(release)).pipe(Stream.flatMap(() => backend.watchTurn(link))),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Service
          yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
          expect(yield* Ref.get(starts)).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(yield* Deferred.await(submitted))
        }).pipe(
          provideLayer(
            productLayer({
              repositoryLayer: ThreadRepository.memoryLayer([thread]),
              turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
              backendLayer: Layer.succeed(ExecutionGateway.Service, admittedBackend),
              defaultWorkspace: "/work",
              makeThreadId: Effect.die("unused"),
              makeTurnId: Effect.succeed(Turn.TurnId.make("admitted-turn")),
              interactive: (_, session) =>
                Effect.gen(function* () {
                  yield* session.selectThread(thread.id, 1)
                  yield* Deferred.succeed(submitted, yield* Effect.forkChild(session.submit("accepted")))
                  yield* Deferred.await(started)
                }),
            }),
          ),
        )
        expect(yield* Ref.get(starts)).toBe(1)
        expect((yield* turns.get(Turn.TurnId.make("admitted-turn")))?.status).toBe("running")
      }),
    ),
  )
})
