import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { Operation } from "@rika/product/product-operation"
import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { backend } from "../support/operation-execution-fixtures"

import { turnProvenance, threadLineage } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("reuses a requested thread and streams every event as JSON", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-existing"),
        lineage: threadLineage,
        workspace: "/existing",
        title: "Existing",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory()
      const layer = Layer.mergeAll(
        TestConsole.layer,
        productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("A reused thread must not create an id"),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-existing")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["existing", "prompt"],
          threadId: "thread-existing",
          ephemeral: false,
          streamJson: true,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      const persisted = yield* repository.list({ includeArchived: true })
      const turn = yield* turns.get(Turn.TurnId.make("turn-existing"))
      expect(persisted).toEqual([thread])
      expect(turn).toMatchObject({ threadId: "thread-existing", prompt: "existing prompt", status: "completed" })
      expect(output.filter((line): line is string => typeof line === "string" && line.startsWith("{"))).toEqual([
        '{"executionId":"turn-existing","cursor":"cursor-started","sequence":0,"type":"execution.started","timestampSource":"server","createdAt":0}',
        '{"executionId":"turn-existing","cursor":"cursor-a","sequence":1,"type":"model.output.completed","createdAt":1,"text":"answer"}',
        '{"executionId":"turn-existing","cursor":"cursor-b","sequence":2,"type":"execution.completed","timestampSource":"server","createdAt":2}',
      ])
    }),
  )

  it.effect("maps a missing requested thread to OperationUnavailable", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          threadId: "missing",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(error).toMatchObject({
        _tag: "OperationUnavailable",
        operation: "Run",
      })
      expect(error.message).toContain("Thread missing does not exist")
    }).pipe(
      provideLayer(
        productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      ),
    ),
  )

  it.effect("rejects a missing initial interactive thread before opening the session", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(
        operation.run({
          _tag: "Interactive",
          prompt: [],
          threadId: "missing",
          ephemeral: false,
        }),
      )
      expect(error).toMatchObject({ _tag: "OperationUnavailable", operation: "Interactive" })
      expect(error.message).toContain("Thread missing does not exist")
    }).pipe(
      provideLayer(
        productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
          interactive: () => Effect.die("Missing thread must not open an interactive session"),
        }),
      ),
    ),
  )

  it.effect("does not start queued submissions", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-a"),
        lineage: threadLineage,
        workspace: "/work",
        title: "Busy",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active"),
          threadId: thread.id,
          prompt: "active",
          ...turnProvenance,
          executionRoute: executionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const starts = yield* Ref.make(0)
      const operationLayer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(
          ExecutionBackend.Service,
          ExecutionBackend.Service.of({
            ...backend,
            inspect: (turnId) =>
              Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
            start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
          }),
        ),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.succeed(Turn.TurnId.make("queued")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["later"],
          threadId: "thread-a",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(provideLayer(operationLayer))
      expect(yield* Ref.get(starts)).toBe(0)
      expect((yield* turns.get(Turn.TurnId.make("queued")))?.status).toBe("queued")
    }),
  )

  it.effect("maps backend failures to OperationUnavailable", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(error).toMatchObject({
        _tag: "OperationUnavailable",
        operation: "Run",
      })
      expect(error.message).toContain("backend failed")
    }).pipe(
      provideLayer(
        productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(
            ExecutionBackend.Service,
            ExecutionBackend.Service.of({
              ...backend,
              start: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "backend failed" })),
            }),
          ),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      ),
    ),
  )
})
