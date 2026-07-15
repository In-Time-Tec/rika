import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { Operation } from "../src/index"
import { provideLayer } from "./layer"

const backend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: () => Effect.die("unused"),
  replay: (turnId) =>
    Effect.succeed({
      turnId,
      status: turnId === "failed" ? "failed" : turnId === "cancelled" ? "cancelled" : "completed",
      events: [],
    }),
  cancel: () => Effect.die("unused"),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: () => Effect.die("unused"),
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.die("unused"),
  resolvePermission: () => Effect.die("unused"),
})

const thread = (id: string, overrides: Partial<Thread.Thread> = {}): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: `/work/${id}`,
  title: `${id} title`,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe("Operation thread actions", () => {
  it.effect("covers list, search, ordering, continuation, export, usage, and failures", () =>
    Effect.gen(function* () {
      const alpha = thread("alpha", { title: "Release Alpha", labels: ["urgent", "red"], updatedAt: 30 })
      const beta = thread("beta", { workspace: "/special/project", labels: ["blue"], updatedAt: 20 })
      const archived = thread("archived", { archived: true, updatedAt: 40 })
      const repository = yield* ThreadRepository.makeMemory([alpha, beta, archived])
      const statuses: ReadonlyArray<Turn.Status> = [
        "accepted",
        "queued",
        "running",
        "waiting",
        "completed",
        "failed",
        "cancelled",
      ]
      const turns = yield* TurnRepository.makeMemory(
        statuses.map((status, index) => ({
          id: Turn.TurnId.make(status),
          threadId: alpha.id,
          prompt: `${status} prompt`,
          status,
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
      )
      const layer = Layer.merge(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("unused")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("unused-turn")),
        }),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "list" })
        yield* operation.run({ _tag: "Thread", action: "list", includeArchived: false, limit: 1 })
        yield* operation.run({ _tag: "Thread", action: "list", includeArchived: true, limit: 100 })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["alpha", "urgent"] })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["special", "blue"], limit: 0 })
        yield* operation.run({
          _tag: "Thread",
          action: "search",
          query: ["archived"],
          includeArchived: true,
          limit: 200,
        })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["absent"] })
        yield* operation.run({ _tag: "Thread", action: "last" })
        yield* operation.run({ _tag: "Thread", action: "top" })
        yield* operation.run({ _tag: "Thread", action: "continue", last: true })
        yield* operation.run({ _tag: "Thread", action: "continue", threadIds: ["alpha", "beta"] })
        yield* operation.run({ _tag: "Thread", action: "export", threadId: "alpha", format: "json" })
        yield* operation.run({ _tag: "Thread", action: "export", threadId: "alpha", format: "markdown" })
        yield* operation.run({ _tag: "Thread", action: "usage", threadId: "alpha" })
        for (const input of [
          { _tag: "Thread", action: "continue", threadIds: ["missing"] },
          { _tag: "Thread", action: "export", threadId: "missing", format: "json" },
          { _tag: "Thread", action: "usage", threadId: "missing" },
        ] as const)
          expect((yield* Effect.result(operation.run(input)))._tag).toBe("Failure")
        const lines = yield* TestConsole.logLines
        expect(
          lines.some((line) => String(line).includes('"accepted":1') && String(line).includes('"cancelled":1')),
        ).toBe(true)
        expect(lines.some((line) => String(line).includes("# Release Alpha"))).toBe(true)
        expect(lines.some((line) => line === "[]")).toBe(true)
      }).pipe(provideLayer(layer))

      const emptyLayer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        expect((yield* Effect.result(operation.run({ _tag: "Thread", action: "last" })))._tag).toBe("Failure")
        expect((yield* Effect.result(operation.run({ _tag: "Thread", action: "top" })))._tag).toBe("Failure")
        expect((yield* Effect.result(operation.run({ _tag: "Thread", action: "continue", last: true })))._tag).toBe(
          "Failure",
        )
      }).pipe(provideLayer(emptyLayer))
    }),
  )

  it.effect("forks complete and bounded history, preserves optional labels, and rejects missing boundaries", () =>
    Effect.gen(function* () {
      const labeled = thread("labeled", { labels: ["copy-me"] })
      const plain = thread("plain")
      const repository = yield* ThreadRepository.makeMemory([labeled, plain])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("one"),
          threadId: labeled.id,
          prompt: "one",
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          lastCursor: "a",
        },
        {
          id: Turn.TurnId.make("two"),
          threadId: labeled.id,
          prompt: "two",
          status: "failed",
          createdAt: 3,
          updatedAt: 4,
        },
      ])
      const threadIds = yield* Ref.make<ReadonlyArray<string>>(["bounded", "complete", "empty"])
      const turnIds = yield* Ref.make<ReadonlyArray<string>>(["bounded-one", "complete-one", "complete-two"])
      const next = (ref: Ref.Ref<ReadonlyArray<string>>) =>
        Ref.modify(ref, (ids) => [ids[0] ?? "fallback", ids.slice(1)] as const)
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: next(threadIds).pipe(Effect.map(Thread.ThreadId.make)),
        makeTurnId: next(turnIds).pipe(Effect.map(Turn.TurnId.make)),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: "labeled", atTurn: "one" })
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: "labeled" })
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: "plain" })
        expect(
          (yield* Effect.result(
            operation.run({ _tag: "Thread", action: "fork", threadId: "labeled", atTurn: "missing" }),
          ))._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.result(operation.run({ _tag: "Thread", action: "fork", threadId: "missing" })))._tag,
        ).toBe("Failure")
      }).pipe(provideLayer(layer))
      expect(yield* turns.list(Thread.ThreadId.make("bounded"))).toHaveLength(1)
      expect(yield* turns.list(Thread.ThreadId.make("complete"))).toMatchObject([
        { prompt: "one", status: "completed", lastCursor: "a" },
        { prompt: "two", status: "failed" },
      ])
      expect(yield* repository.get(Thread.ThreadId.make("bounded"))).toMatchObject({ labels: ["copy-me"] })
      expect(yield* repository.get(Thread.ThreadId.make("empty"))).toMatchObject({ labels: [] })
    }),
  )
})
