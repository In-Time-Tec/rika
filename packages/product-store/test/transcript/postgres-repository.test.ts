import type { InteractiveSession } from "@rika/product/interactive-session"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/postgres-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/postgres-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"

import { executionRoute } from "../turn/postgres/repository-state.fixture"
import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../turn/postgres/repository.harness"
import { holdSession, openInteractiveSession, settleEvents } from "../turn/postgres/repository-session.harness"
import { backend } from "../turn/postgres/repository.fixture"

import { turnProvenance, threadLineage, selectionThread } from "../turn/postgres/repository-selection.fixture"

describe("Operation", () => {
  it.effect("continues, searches, exports, and summarizes persisted threads", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-a"),
        lineage: threadLineage,
        workspace: "/work/project",
        title: "Release notes",
        labels: ["urgent"],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      }
      const turn: Turn.Turn = {
        id: Turn.TurnId.make("turn-a"),
        threadId: thread.id,
        prompt: "Write the release",
        ...turnProvenance,
        executionRoute: executionRoute(),
        status: "completed",
        createdAt: 3,
        updatedAt: 4,
      }
      const layer = Layer.merge(
        TestConsole.layer,
        productLayer({
          executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
          repositoryLayer: ThreadRepository.memoryLayer([thread]),
          turnRepositoryLayer: TurnRepository.memoryLayer([turn]),
          backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("unused")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("unused")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({ _tag: "Thread", action: "continue", last: true })
        yield* operation.run({ _tag: "Thread", action: "continue", threadIds: ["thread-a"] })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["project", "urgent"] })
        yield* operation.run({ _tag: "Thread", action: "export", threadId: "thread-a", format: "json" })
        yield* operation.run({ _tag: "Thread", action: "export", threadId: "thread-a", format: "markdown" })
        yield* operation.run({ _tag: "Thread", action: "usage", threadId: "thread-a" })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      expect(output[0]).toContain('"id":"thread-a"')
      expect(output[0]).toContain('"status":"completed"')
      expect(output[1]).toContain('"id":"thread-a"')
      expect(output[2]).toContain('"title":"Release notes"')
      expect(output[3]).toContain('"prompt":"Write the release"')
      expect(output[4]).toContain("# Release notes")
      expect(output[5]).toContain('"completed":1')
    }),
  )

  it.effect("forks persisted history through a requested turn", () =>
    Effect.gen(function* () {
      const source: Thread.Thread = {
        id: Thread.ThreadId.make("source"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Source",
        labels: ["kept"],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      }
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("one"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "one",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 3,
          updatedAt: 4,
        },
        {
          id: Turn.TurnId.make("two"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "two",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 5,
          updatedAt: 6,
        },
      ])
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("fork")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("fork-turn")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: "source", atTurn: "one" })
      }).pipe(provideLayer(layer))
      expect(yield* turns.list(Thread.ThreadId.make("fork"))).toMatchObject([{ prompt: "one", status: "completed" }])
      expect(yield* repository.get(Thread.ThreadId.make("fork"))).toMatchObject({ title: "Source", labels: ["kept"] })
    }),
  )

  it.effect("forks queued history with consistent bounded queue state", () =>
    Effect.gen(function* () {
      const source = selectionThread("queued-fork-source")
      const sourceTurns: ReadonlyArray<Turn.Turn> = [
        {
          id: Turn.TurnId.make("fork-history"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "history",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("fork-queued-one"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "queued one",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("fork-queued-two"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "queued two",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ]
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory(sourceTurns)
      const turnSequence = yield* Ref.make(0)
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 2,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("queued-fork")),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`queued-fork-copy-${value}`)),
        ),
      })

      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: source.id })
      }).pipe(provideLayer(layer))

      expect((yield* turns.list(Thread.ThreadId.make("queued-fork"))).map((turn) => turn.status)).toEqual([
        "completed",
        "queued",
        "queued",
      ])
      expect(yield* turns.readQueue(Thread.ThreadId.make("queued-fork"))).toMatchObject({
        revision: 2,
        queuedCount: 2,
        turns: [{ prompt: "queued one" }, { prompt: "queued two" }],
      })
    }),
  )

  it.effect("rejects a fork before creation when copied queue history exceeds capacity", () =>
    Effect.gen(function* () {
      const source = selectionThread("bounded-fork-source")
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory(
        ["one", "two"].map(
          (id, index): Turn.AgentExecutionTurn => ({
            _tag: "AgentExecution",
            id: Turn.TurnId.make(`bounded-fork-${id}`),
            author: turnProvenance.author,
            lineage: turnProvenance.lineage,
            threadId: source.id,
            prompt: id,
            executionRoute: executionRoute(),
            status: "queued",
            createdAt: index + 1,
            updatedAt: index + 1,
          }),
        ),
      )
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 1,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("bounded-fork")),
        makeTurnId: Effect.die("must preflight capacity"),
      })

      const result = yield* Effect.gen(function* () {
        const operation = yield* Service
        return yield* Effect.result(operation.run({ _tag: "Thread", action: "fork", threadId: source.id }))
      }).pipe(provideLayer(layer))

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OperationUnavailable", message: expect.stringContaining("TurnQueueFull") },
      })
      expect(yield* repository.get(Thread.ThreadId.make("bounded-fork"))).toBeUndefined()
    }),
  )

  it.effect("keeps fork copy and publication atomic against racing submissions", () =>
    Effect.gen(function* () {
      const source = selectionThread("atomic-fork-source")
      const forkId = Thread.ThreadId.make("atomic-fork")
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("atomic-fork-active"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "source active",
          executionRoute: executionRoute(),
          executionLink: {
            runId: "atomic-fork-active-run",
            turnId: "atomic-fork-active",
            threadId: source.id,
          },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("atomic-fork-queued"),
          ...turnProvenance,
          threadId: source.id,
          prompt: "source queued",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const copyEntered = yield* Deferred.make<void>()
      const releaseCopy = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        copy: (turn, capacity) =>
          turn.threadId === forkId && turn.prompt === "source active"
            ? Deferred.succeed(copyEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCopy)),
                Effect.andThen(turns.copy(turn, capacity)),
              )
            : turns.copy(turn, capacity),
      })
      const forkBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: () => Effect.succeed({ status: "running", cursor: "synthetic-running-cursor" }),
        startTurn: (input) =>
          Effect.succeed({ runId: "atomic-fork-run", turnId: input.turnId, threadId: input.threadId }),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const turnSequence = yield* Ref.make(0)
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, delayedTurns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, forkBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 1,
        makeThreadId: Effect.succeed(forkId),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`atomic-fork-copy-${value}`)),
        ),
        interactive: holdSession(sessions),
      })

      const forkResult = yield* Effect.gen(function* () {
        const operation = yield* Service
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const fork = yield* Effect.forkChild(
          Effect.result(operation.run({ _tag: "Thread", action: "fork", threadId: source.id })),
        )
        yield* Deferred.await(copyEntered)
        yield* session.selectThread(forkId)
        const submissions = yield* Effect.forEach(["racing one", "racing two"], (prompt) =>
          Effect.forkChild(session.submit(prompt)),
        )
        yield* settleEvents
        yield* Deferred.succeed(releaseCopy, undefined)
        const result = yield* Fiber.join(fork)
        yield* Effect.forEach(submissions, Fiber.join, { discard: true })
        return result
      }).pipe(provideLayer(layer))

      expect(forkResult._tag).toBe("Success")
      expect((yield* turns.list(forkId)).map((turn) => [turn.prompt, turn.status])).toEqual([
        ["source active", "running"],
        ["source queued", "queued"],
      ])
      expect(yield* repository.get(forkId)).toMatchObject({ archived: false })
    }),
  )
})
