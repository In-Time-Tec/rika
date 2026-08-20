import { Service } from "@rika/product/product-operation-service"
import { productLayer } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { projectionVersion } from "@rika/product/execution-projection"
import { Console, Effect, Layer, Ref, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { executionSessionLifecycleLayerTest } from "../support/operation-layer-harness"

import { provideLayer } from "../support/product-test-layer"

const backend = ExecutionGateway.Service.of({
  startTurn: () => Effect.die("unused"),
  cancelTurn: () => Effect.die("unused"),
  steerTurn: () => Effect.die("unused"),
  approveTurn: () => Effect.void,
  denyTurn: () => Effect.void,
  watchTurn: () => Stream.die("unused"),
  inspectTurn: () => Effect.succeed({ status: "unavailable" }),
})

const thread = (id: string, overrides: Partial<Thread.Thread> = {}): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: `/work/${id}`,
  title: `${id} title`,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
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
      const statuses: ReadonlyArray<ExecutionStatus.Status> = [
        "accepted",
        "queued",
        "running",
        "waiting",
        "completed",
        "failed",
        "cancelled",
      ]
      const turns = yield* TurnRepository.makeMemory(
        statuses.map(
          (status, index): Turn.AgentExecutionTurn => ({
            _tag: "AgentExecution",
            id: Turn.TurnId.make(status),
            threadId: alpha.id,
            prompt: `${status} prompt`,
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status,
            createdAt: index + 1,
            updatedAt: index + 1,
          }),
        ),
      )
      const layer = Layer.merge(
        TestConsole.layer,
        productLayer({
          executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("unused")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("unused-turn")),
        }),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Service
        const routedOutput: Array<string> = []
        const requestConsole = Object.assign(Object.create(globalThis.console), {
          log: (...values: ReadonlyArray<unknown>) => routedOutput.push(values.map(String).join(" ")),
        }) as Console.Console
        yield* operation
          .run({ _tag: "Thread", action: "list" })
          .pipe(Effect.provideService(Console.Console, requestConsole))
        expect(routedOutput).toHaveLength(1)
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

      const emptyLayer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Service
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
          _tag: "AgentExecution",
          id: Turn.TurnId.make("one"),
          threadId: labeled.id,
          prompt: "one",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
        },
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("two"),
          threadId: labeled.id,
          prompt: "two",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "failed",
          createdAt: 3,
          updatedAt: 4,
        },
      ])
      const threadIds = yield* Ref.make<ReadonlyArray<string>>(["bounded", "complete", "empty"])
      const turnIds = yield* Ref.make<ReadonlyArray<string>>(["bounded-one", "complete-one", "complete-two"])
      const next = (ref: Ref.Ref<ReadonlyArray<string>>) =>
        Ref.modify(ref, (ids) => [ids[0] ?? "fallback", ids.slice(1)] as const)
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: next(threadIds).pipe(Effect.map(Thread.ThreadId.make)),
        makeTurnId: next(turnIds).pipe(Effect.map(Turn.TurnId.make)),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Service
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
        { prompt: "one", status: "completed" },
        { prompt: "two", status: "failed" },
      ])
      expect(yield* repository.get(Thread.ThreadId.make("bounded"))).toMatchObject({ labels: ["copy-me"] })
      expect(yield* repository.get(Thread.ThreadId.make("empty"))).toMatchObject({ labels: [] })
    }),
  )

  it.effect("forks terminal recorded shells with their canonical transcript and no TenetKit Run", () =>
    Effect.gen(function* () {
      const source = thread("shell-source")
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory([
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("source-agent"),
          threadId: source.id,
          prompt: "agent history",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      const sourceShell = yield* turns.copyRecordedShell({
        _tag: "RecordedShell",
        id: Turn.TurnId.make("source-shell"),
        threadId: source.id,
        prompt: "$ printf copied",
        command: "printf copied",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        status: "completed",
        createdAt: 3,
        updatedAt: 4,
        result: { text: "copied", truncated: false, exitCode: 0 },
      })
      yield* transcripts.replaceUnits(
        sourceShell,
        settleRecordedShellProjection(
          recordedShellProjection({ id: sourceShell.id, command: sourceShell.command, status: "running" }),
          sourceShell,
        ).units,
      )
      const inspected = yield* Ref.make<ReadonlyArray<string>>([])
      const forkBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: (link) =>
          Ref.update(inspected, (ids) => [...ids, link.turnId]).pipe(Effect.as({ status: "unavailable" })),
      })
      const turnIds = yield* Ref.make<ReadonlyArray<string>>(["fork-agent", "fork-shell"])
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
        backendLayer: Layer.succeed(ExecutionGateway.Service, forkBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-fork")),
        makeTurnId: Ref.modify(turnIds, (ids) => [Turn.TurnId.make(ids[0] ?? "missing"), ids.slice(1)] as const),
      })

      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: source.id })
      }).pipe(provideLayer(layer))

      const forked = yield* turns.list(Thread.ThreadId.make("shell-fork"))
      expect(forked).toMatchObject([
        { _tag: "AgentExecution", id: "fork-agent", prompt: "agent history", status: "completed" },
        {
          _tag: "RecordedShell",
          id: "fork-shell",
          prompt: "$ printf copied",
          command: "printf copied",
          status: "completed",
          result: { text: "copied", truncated: false, exitCode: 0 },
        },
      ])
      expect(yield* transcripts.get(Turn.TurnId.make("fork-shell"))).toMatchObject({
        turn: { _tag: "RecordedShell", id: "fork-shell", status: "completed" },
        revision: 1,
        checkpointGeneration: 0,
        units: [
          {
            revision: 1,
            content: {
              _tag: "Block",
              block: { _tag: "ToolCall", detail: "printf copied", output: "copied", status: "complete" },
            },
          },
        ],
        projectionVersion: projectionVersion,
      })
      expect(yield* Ref.get(inspected)).toEqual([])
    }),
  )

  it.effect("rejects a running recorded shell before creating a fork", () =>
    Effect.gen(function* () {
      const source = thread("running-shell-source")
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory()
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      const runningShell = yield* turns.createRecordedShell({
        _tag: "RecordedShell",
        id: Turn.TurnId.make("running-shell"),
        threadId: source.id,
        prompt: "$ sleep 10",
        command: "sleep 10",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      })
      yield* transcripts.replaceUnits(runningShell, recordedShellProjection(runningShell).units)
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
        backendLayer: Layer.succeed(
          ExecutionGateway.Service,
          ExecutionGateway.Service.of({ ...backend, inspectTurn: () => Effect.die("recorded shell reached gateway") }),
        ),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("forbidden-shell-fork")),
        makeTurnId: Effect.die("fork turn id must not be allocated"),
      })

      const result = yield* Effect.gen(function* () {
        const operation = yield* Service
        return yield* Effect.result(operation.run({ _tag: "Thread", action: "fork", threadId: source.id }))
      }).pipe(provideLayer(layer))

      expect(result._tag).toBe("Failure")
      expect(yield* repository.get(Thread.ThreadId.make("forbidden-shell-fork"))).toBeUndefined()
      expect(yield* turns.list(source.id)).toMatchObject([
        { _tag: "RecordedShell", id: "running-shell", status: "running" },
      ])
    }),
  )
})
