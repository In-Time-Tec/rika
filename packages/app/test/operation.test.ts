import { describe, expect, it } from "@effect/vitest"
import { ConfigContract } from "@rika/config"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions, PluginRegistry } from "@rika/extensions"
import { Effect, Layer, Ref, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { Operation, ResolvedContext } from "../src/index"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.provide(effect, context)
      }),
    )

const nonActivation = (list: ReadonlyArray<Operation.InteractiveEvent>) =>
  list.filter((event) => event._tag !== "ThreadActivated")

const reconcileDependencies = (extensions: ExecutionExtensions.Interface) =>
  Layer.merge(
    ResolvedContext.testLayer({ resolve: () => Effect.die("unused") }),
    Layer.succeed(ExecutionExtensions.Service, extensions),
  )

const unusedExtensions = ExecutionExtensions.Service.of({
  future: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
})

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
    Effect.succeed({
      turnId: input.turnId,
      status: "completed",
      events: [
        { cursor: "cursor-a", sequence: 1, type: "model.output.completed", createdAt: 1, text: "answer" },
        { cursor: "cursor-b", sequence: 2, type: "execution.completed", createdAt: 2 },
      ],
    }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: () => Effect.void,
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.void,
  resolvePermission: () => Effect.void,
})

describe("Operation", () => {
  it.effect("rejects secret-bearing config before execution_route_json persistence", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const turns = yield* TurnRepository.makeMemory([])
      const writes = yield* Ref.make(0)
      const repository = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(turns.createForSubmission(input))),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, repository),
            backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
            resolveExecutionRoute: () =>
              Effect.try(() => {
                ConfigContract.decodeSettingsInput("settings.json", {
                  models: {
                    unsafe: {
                      ...ConfigContract.defaults.models.luna,
                      variants: { low: { normal: { options: { nested: { signature: "secret" } } } } },
                    },
                  },
                })
                return Turn.testExecutionRoute("medium")
              }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-rejected-config")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("turn-rejected-config")),
            interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
          }),
        ),
      )
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("missing session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.submit("must not persist", (event) => events.push(event))
      expect(events.map((event) => event._tag)).toContain("ExecutionFailed")
      expect(yield* Ref.get(writes)).toBe(0)
      expect(yield* turns.get(Turn.TurnId.make("turn-rejected-config"))).toBeUndefined()
    }),
  )

  it.effect("keeps one backend layer alive for sequential interactive submissions", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const acquisitions = yield* Ref.make(0)
      const turnIds = yield* Ref.make(0)
      const turns = yield* TurnRepository.makeMemory([])
      const backendLayer = Layer.effect(
        ExecutionBackend.Service,
        Ref.updateAndGet(acquisitions, (value) => value + 1).pipe(
          Effect.map((generation) =>
            ExecutionBackend.Service.of({
              ...backend,
              start: (input) =>
                Ref.update(starts, (values) => [...values, `${generation}:${input.prompt}`]).pipe(
                  Effect.andThen(backend.start(input)),
                ),
            }),
          ),
        ),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer,
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-sequential")),
            makeTurnId: Ref.updateAndGet(turnIds, (value) => value + 1).pipe(
              Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
            ),
            interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
          }),
        ),
      )
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("missing session")
      yield* session.submit("First turn", () => {}, "low")
      yield* session.submit("Second turn", () => {}, "ultra")
      expect(yield* Ref.get(acquisitions)).toBe(1)
      expect((yield* Ref.get(starts)).filter((value) => !value.includes("Generate a concise"))).toEqual([
        "1:First turn",
        "1:Second turn",
      ])
      expect((yield* turns.get(Turn.TurnId.make("turn-1")))?.executionRoute?.mode).toBe("low")
      expect((yield* turns.get(Turn.TurnId.make("turn-2")))?.executionRoute?.mode).toBe("ultra")
      expect((yield* turns.get(Turn.TurnId.make("turn-2")))?.status).toBe("completed")
    }),
  )

  it.effect("reconciles nonterminal turns and restarts a missing deterministic execution", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("turn-restart"),
          threadId: Thread.ThreadId.make("thread-restart"),
          prompt: "resume",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const restartBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, input]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* Operation.reconcile().pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, restartBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toMatchObject([
        { threadId: "thread-restart", turnId: "turn-restart", prompt: "resume", startedAt: 2 },
      ])
      expect((yield* turns.get(Turn.TurnId.make("turn-restart")))?.status).toBe("completed")
    }),
  )

  it.effect("reconciles review route owners through their fan-out without executing the parent prompt", () =>
    Effect.gen(function* () {
      const owner = Turn.TurnId.make("review-owner")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: owner,
          threadId: Thread.ThreadId.make("review-thread"),
          prompt: "Review workspace changes",
          status: "running",
          executionRoute: Turn.testExecutionRoute("medium"),
          reviewFanOutId: "review:review-owner",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make(0)
      const inspections = yield* Ref.make(0)
      const routeOwnerBackend = ExecutionBackend.Service.of({
        ...backend,
        start: () => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(Effect.die("must not start"))),
        inspect: () => Effect.die("must not inspect as a turn"),
        inspectFanOut: () =>
          Ref.updateAndGet(inspections, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    fanOutId: "review:review-owner",
                    parentTurnId: owner,
                    state: "joining" as const,
                    maxConcurrency: 3,
                    join: "best-effort" as const,
                    members: [],
                  }
                : undefined,
            ),
          ),
      })
      const dependencies = Layer.mergeAll(
        reconcileDependencies(unusedExtensions),
        ThreadRepository.memoryLayer(),
        Layer.succeed(TurnRepository.Service, turns),
        Layer.succeed(ExecutionBackend.Service, routeOwnerBackend),
      )
      yield* Operation.reconcile().pipe(provideLayer(dependencies))
      expect((yield* turns.get(owner))?.status).toBe("running")
      yield* Operation.reconcile().pipe(provideLayer(dependencies))
      expect((yield* turns.get(owner))?.status).toBe("failed")
      expect(yield* Ref.get(starts)).toBe(0)
    }),
  )

  it.effect("reconciles FIFO successors after failed and cancelled turns", () =>
    Effect.gen(function* () {
      const threadId = Thread.ThreadId.make("terminal-fifo")
      const turns = yield* TurnRepository.makeMemory(
        ["failed", "cancelled", "completed"].map((id, index) => ({
          id: Turn.TurnId.make(id),
          threadId,
          prompt: id,
          status: "queued" as const,
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
      )
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const terminalBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.as({
              turnId: input.turnId,
              status:
                input.turnId === "failed"
                  ? ("failed" as const)
                  : input.turnId === "cancelled"
                    ? ("cancelled" as const)
                    : ("completed" as const),
              events: [],
            }),
          ),
      })
      yield* Operation.reconcile().pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, terminalBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["failed", "cancelled", "completed"])
    }),
  )

  it.effect("fails legacy active and queued turns and reconciles the next routed turn", () =>
    Effect.gen(function* () {
      const threadId = Thread.ThreadId.make("legacy-reconcile")
      const turns = yield* TurnRepository.makeMemory(
        [
          {
            id: Turn.TurnId.make("active"),
            threadId,
            prompt: "active",
            status: "running",
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: Turn.TurnId.make("legacy"),
            threadId,
            prompt: "legacy",
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: Turn.TurnId.make("routed"),
            threadId,
            prompt: "routed",
            status: "queued",
            executionRoute: Turn.testExecutionRoute("high"),
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        true,
      )
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const routedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* Operation.reconcile().pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, routedBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["routed"])
      expect((yield* turns.get(Turn.TurnId.make("active")))?.status).toBe("failed")
      expect((yield* turns.get(Turn.TurnId.make("legacy")))?.status).toBe("failed")
      expect((yield* turns.get(Turn.TurnId.make("routed")))?.status).toBe("completed")
    }),
  )

  it.effect("records operations through the test layer", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Doctor" })
      }).pipe(provideLayer(Operation.testLayer(calls)))
      expect(yield* Ref.get(calls)).toEqual([{ _tag: "Doctor" }])
    }),
  )

  it.effect("reports unavailable operations as expected failures", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const unavailable = yield* Effect.result(operation.run({ _tag: "Doctor" }))
      const run = yield* Effect.result(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(unavailable._tag).toBe("Failure")
      expect(run._tag).toBe("Failure")
    }).pipe(provideLayer(Operation.unavailableLayer)),
  )

  it.effect("starts, inspects, and reports missing workflow runs", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const workflowBackend = ExecutionBackend.Service.of({
        ...backend,
        registerWorkflows: () => Ref.update(calls, (values) => [...values, "register"]).pipe(Effect.as([])),
        startWorkflow: (name, runId, revision) =>
          Ref.update(calls, (values) => [...values, `start:${name}:${runId}:${revision}`]).pipe(
            Effect.as({
              runId,
              workflow: name,
              revision: revision ?? 1,
              digest: "digest",
              status: "running" as const,
              createdAt: 1,
              updatedAt: 1,
            }),
          ),
        inspectWorkflow: (runId) =>
          Ref.update(calls, (values) => [...values, `inspect:${runId}`]).pipe(
            Effect.as(
              runId === "missing"
                ? undefined
                : {
                    runId,
                    workflow: "delivery",
                    revision: 2,
                    digest: "digest",
                    status: "completed" as const,
                    createdAt: 1,
                    updatedAt: 2,
                  },
            ),
          ),
      })
      const layer = Layer.merge(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, workflowBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Workflow", action: "start", name: "delivery", runId: "run", revision: 2 })
        yield* operation.run({ _tag: "Workflow", action: "inspect", runId: "run" })
        return yield* Effect.result(operation.run({ _tag: "Workflow", action: "inspect", runId: "missing" }))
      }).pipe(provideLayer(layer))
      expect(output._tag).toBe("Failure")
      expect(yield* Ref.get(calls)).toEqual(["register", "start:delivery:run:2", "inspect:run", "inspect:missing"])
    }),
  )

  it.effect("runs thread metadata and tool catalog operations", () =>
    Effect.gen(function* () {
      const ids = yield* Ref.make(["thread-a", "session-a"] as ReadonlyArray<string>)
      const nextId = Effect.gen(function* () {
        const values = yield* Ref.get(ids)
        const value = values[0]
        if (value === undefined) return yield* Effect.die("No test id")
        yield* Ref.set(ids, values.slice(1))
        return value
      })
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const layer = Layer.mergeAll(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: nextId.pipe(Effect.map(Thread.ThreadId.make)),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "new", clientWorkspace: "/client-work" })
        yield* operation.run({ _tag: "Thread", action: "rename", threadId: "thread-a", title: "Named" })
        yield* operation.run({ _tag: "Thread", action: "label", threadId: "thread-a", labels: ["one"] })
        yield* operation.run({ _tag: "Thread", action: "pin", threadId: "thread-a" })
        yield* operation.run({ _tag: "Thread", action: "archive", threadId: "thread-a" })
        yield* operation.run({ _tag: "Thread", action: "list", includeArchived: true })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["Named"], includeArchived: true })
        yield* operation.run({ _tag: "Thread", action: "unarchive", threadId: "thread-a" })
        yield* operation.run({ _tag: "ToolCatalog", action: "list" })
        yield* operation.run({ _tag: "ToolCatalog", action: "show", name: "read_file" })
        const missing = yield* Effect.result(operation.run({ _tag: "ToolCatalog", action: "show", name: "missing" }))
        yield* operation.run({ _tag: "Thread", action: "delete", threadId: "thread-a" })
        expect(missing._tag).toBe("Failure")
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      const lines = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(output)
      expect(lines.some((line) => line.includes('"title":"Named"'))).toBe(true)
      expect(lines.some((line) => line.includes('"workspace":"/client-work"'))).toBe(true)
      expect(lines.some((line) => line.includes('"name":"read_file"'))).toBe(true)
    }),
  )

  it.effect("continues, searches, exports, and summarizes persisted threads", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-a"),
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
        status: "completed",
        createdAt: 3,
        updatedAt: 4,
      }
      const layer = Layer.merge(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer([thread]),
          turnRepositoryLayer: TurnRepository.memoryLayer([turn]),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("unused")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("unused")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
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
          threadId: source.id,
          prompt: "one",
          status: "completed",
          createdAt: 3,
          updatedAt: 4,
        },
        {
          id: Turn.TurnId.make("two"),
          threadId: source.id,
          prompt: "two",
          status: "completed",
          createdAt: 5,
          updatedAt: 6,
        },
      ])
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("fork")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("fork-turn")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: "source", atTurn: "one" })
      }).pipe(provideLayer(layer))
      expect(yield* turns.list(Thread.ThreadId.make("fork"))).toMatchObject([{ prompt: "one", status: "completed" }])
      expect(yield* repository.get(Thread.ThreadId.make("fork"))).toMatchObject({ title: "Source", labels: ["kept"] })
    }),
  )

  it.effect("uses the configured interactive operation", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
      const input: Operation.Input = {
        _tag: "Interactive",
        prompt: ["hello"],
        workspace: "/interactive",
        ephemeral: false,
      }
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run(input)
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: TurnRepository.memoryLayer(),
            backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
            interactive: (interactiveInput) => Ref.update(received, (inputs) => [...inputs, interactiveInput]),
          }),
        ),
      )
      expect(yield* Ref.get(received)).toEqual([input])
    }),
  )

  it.effect("exercises every interactive session control and its safe failure path", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer([
          {
            id: Turn.TurnId.make("orphan"),
            threadId: Thread.ThreadId.make("orphan-thread"),
            prompt: "queued",
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn")),
        interactive: (_, session) => Ref.update(sessions, (all) => [...all, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("missing session")
      yield* session.initialize(dispatch)
      yield* session.shell("pwd", false, dispatch)
      yield* session.editQueued("orphan", "changed", dispatch)
      yield* session.dequeue("missing", dispatch)
      yield* session.steer("direction", dispatch)
      yield* session.interruptAndSend("next", dispatch)
      yield* session.cancel(dispatch)
      yield* session.resolvePermission("wait", "permission", "allow", dispatch)
      yield* session.resolvePermission("wait", "permission", "deny", dispatch)
      yield* session.resolvePermission("wait", "permission", "always", dispatch)
      yield* session.selectThread("missing", dispatch)
      yield* session.reopenThread(dispatch)
      yield* session.replay("turn", undefined, dispatch)
      expect((yield* Ref.get(events)).filter((event) => event._tag === "ExecutionFailed").length).toBeGreaterThan(0)
      expect((yield* Ref.get(events)).at(-1)).toMatchObject({
        _tag: "ExecutionFailed",
        message: expect.stringContaining("No thread selected"),
      })
    }),
  )

  it.effect("promotes queued turns through the thread host when the backend supports it", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const ensured = yield* Ref.make<ReadonlyArray<readonly [string, number]>>([])
      const notified = yield* Ref.make<ReadonlyArray<readonly [string, string | undefined]>>([])
      const promoters = yield* Ref.make<ReadonlyArray<ExecutionBackend.TurnPromoter>>([])
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("hosted"),
        workspace: "/work",
        title: "Hosted",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const hostedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(started, (all) => [...all, input.turnId]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
        inspect: (turnId) =>
          Effect.succeed(
            turnId === "busy"
              ? {
                  turnId,
                  status: "running" as const,
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined,
          ),
        ensureThreadHost: (threadId, createdAt) =>
          Ref.update(ensured, (all) => [...all, [threadId, createdAt] as const]),
        notifyThreadHost: (threadId, turnId) => Ref.update(notified, (all) => [...all, [threadId, turnId] as const]),
        registerTurnPromoter: (promoter) => Ref.update(promoters, (all) => [...all, promoter]),
      })
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: TurnRepository.memoryLayer([
          {
            id: Turn.TurnId.make("busy"),
            threadId: thread.id,
            prompt: "active",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        backendLayer: Layer.succeed(ExecutionBackend.Service, hostedBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(thread.id),
        makeTurnId: Effect.succeed(Turn.TurnId.make("queued-turn")),
        interactive: (_, session) => Ref.update(sessions, (all) => [...all, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("missing session")
      yield* session.selectThread("hosted", dispatch)
      yield* session.submit("while busy", dispatch)
      expect(yield* Ref.get(started)).not.toContain("queued-turn")
      expect((yield* Ref.get(ensured)).length).toBeGreaterThanOrEqual(1)
      expect((yield* Ref.get(ensured))[0]?.[0]).toBe("hosted")
      expect(yield* Ref.get(notified)).toContainEqual(["hosted", undefined])
      expect(yield* Ref.get(notified)).toContainEqual(["hosted", "queued-turn"])
      expect((yield* Ref.get(promoters)).length).toBeGreaterThan(0)
      const queueEvents = (yield* Ref.get(events)).filter((event) => event._tag === "QueueChanged")
      expect(queueEvents.length).toBeGreaterThan(0)
      const promoter = (yield* Ref.get(promoters))[0]
      if (promoter === undefined) return yield* Effect.die("missing promoter")
      expect(yield* promoter("missing-thread")).toBe(0)
    }),
  )

  it.effect("dispatches successful interactive queue and control callbacks", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interactive-controls"),
        workspace: "/work",
        title: "Controls",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active-control"),
          threadId: thread.id,
          prompt: "active",
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("queued-control"),
          threadId: thread.id,
          prompt: "queued",
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("queued-control-2"),
          threadId: thread.id,
          prompt: "queued second",
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) =>
        runSync(Ref.update(events, (current) => [...current, event]))
      const controlBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed({
            turnId,
            status: "running",
            lastCursor: "inspected",
            waits: [],
            pendingTools: [],
            children: [],
          }),
        cancel: (turnId) =>
          Effect.succeed({
            turnId,
            status: "cancelled",
            events: [{ cursor: "cancelled", sequence: 1, type: "execution.cancelled", createdAt: 3 }],
          }),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, controlBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("submitted-control")),
            interactive: (_, session) => Ref.update(sessions, (current) => [...current, session]),
          }),
        ),
      )
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      yield* session.selectThread(thread.id, dispatch)
      yield* session.editQueued("queued-control", "edited", dispatch)
      yield* session.dequeue("queued-control", dispatch)
      yield* session.submit("later", dispatch)
      yield* session.steerQueued("queued-control-2", "redirect", dispatch)
      yield* session.resolvePermission("wait", "permission", "allow", dispatch)
      yield* session.replay("active-control", "cursor", dispatch)
      yield* session.cancel(dispatch)
      yield* session.reopenThread(dispatch)
      const dispatched = yield* Ref.get(events)
      expect(dispatched.some((event) => event._tag === "ThreadSelected")).toBe(true)
      expect(dispatched.some((event) => event._tag === "QueueChanged")).toBe(true)
      expect(dispatched.some((event) => event._tag === "QueueChanged")).toBe(true)
      expect(dispatched.filter((event) => event._tag === "ExecutionControlled")).toHaveLength(3)
      expect(dispatched.some((event) => event._tag === "ExecutionReplayed")).toBe(true)
      expect(yield* turns.get(Turn.TurnId.make("active-control"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancelled",
      })
      expect(yield* turns.get(Turn.TurnId.make("queued-control-2"))).toBeUndefined()
      expect(yield* turns.get(Turn.TurnId.make("submitted-control"))).toMatchObject({ status: "completed" })
    }),
  )

  it.effect("interrupts an active turn and starts the replacement callback", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interrupt-thread"),
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
          threadId: thread.id,
          prompt: "active",
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: (turnId) =>
                Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
            }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("replacement")),
            interactive: (_, session) => Ref.update(sessions, (all) => [...all, session]),
          }),
        ),
      )
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing session")
      yield* session.reopenThread((event) => runSync(Ref.update(events, (all) => [...all, event])))
      yield* session.interruptAndSend("replacement prompt", (event) =>
        runSync(Ref.update(events, (all) => [...all, event])),
      )
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({ status: "cancelled" })
      expect(yield* turns.get(Turn.TurnId.make("replacement"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("QueueChanged")
    }),
  )

  it.effect("durably submits interactive prompts and projects completion", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const liveBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          backend.start(input).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                for (const event of result.events) input.onEvent?.(event)
              }),
            ),
          ),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, liveBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-interactive")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-interactive")),
        interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      yield* session.submit("exact prompt", (event) => runSync(Ref.update(events, (values) => [...values, event])))
      const dispatched = yield* Ref.get(events)
      expect(dispatched.slice(0, 5)).toEqual([
        { _tag: "ThreadActivated", threadId: "thread-interactive", title: "exact prompt" },
        {
          _tag: "TurnStarted",
          threadId: "thread-interactive",
          turn: expect.objectContaining({
            id: "turn-interactive",
            threadId: "thread-interactive",
            prompt: "exact prompt",
            status: "accepted",
          }),
        },
        {
          _tag: "ExecutionEventReceived",
          threadId: "thread-interactive",
          turnId: "turn-interactive",
          event: { cursor: "cursor-a", sequence: 1, type: "model.output.completed", createdAt: 1, text: "answer" },
        },
        {
          _tag: "ExecutionEventReceived",
          threadId: "thread-interactive",
          turnId: "turn-interactive",
          event: { cursor: "cursor-b", sequence: 2, type: "execution.completed", createdAt: 2 },
        },
        { _tag: "QueueChanged", threadId: "thread-interactive", turns: [] },
      ])
      expect(dispatched[5]).toMatchObject({ _tag: "ThreadTitled", threadId: "thread-interactive", title: "answer" })
      expect(dispatched[6]?._tag).toBe("ThreadsListed")
      expect(yield* turns.get(Turn.TurnId.make("turn-interactive"))).toMatchObject({
        prompt: "exact prompt",
        status: "completed",
        lastCursor: "cursor-b",
      })
    }),
  )

  it.effect("titles a new thread through its selected mode backend", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const backendFor = (mode: string) =>
        ExecutionBackend.Service.of({
          ...backend,
          start: (input) =>
            Ref.update(starts, (values) => [...values, `${mode}:${input.turnId}`]).pipe(
              Effect.andThen(
                mode === "high"
                  ? Effect.succeed({
                      turnId: input.turnId,
                      status: "completed" as const,
                      events: [
                        {
                          cursor: `cursor:${input.turnId}:output`,
                          sequence: 1,
                          type: "model.output.completed" as const,
                          createdAt: 1,
                          text: input.turnId.startsWith("title:") ? "Selected Route Title" : "answer",
                        },
                        {
                          cursor: `cursor:${input.turnId}:completed`,
                          sequence: 2,
                          type: "execution.completed" as const,
                          createdAt: 2,
                        },
                      ],
                    })
                  : Effect.fail(ExecutionBackend.BackendError.make({ message: `${mode} backend must not start` })),
              ),
            ),
        })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backendFor("high")),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-selected-title")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-selected-title")),
        interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      yield* session.submit("Build groceries", () => {}, "high")

      expect(yield* Ref.get(starts)).toEqual([
        "high:turn-selected-title",
        expect.stringMatching(/^high:title:thread-selected-title:/),
      ])
      expect(yield* repository.get(Thread.ThreadId.make("thread-selected-title"))).toMatchObject({
        title: "Selected Route Title",
      })
    }),
  )

  it.effect("keeps the seed title when best-effort titling fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const titleFailingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          input.turnId.startsWith("title:")
            ? Effect.fail(ExecutionBackend.BackendError.make({ message: "title unavailable" }))
            : backend.start(input),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, titleFailingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-title-failure")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-title-failure")),
        interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      yield* session.submit("Stable seed title", (event) => runSync(Ref.update(events, (values) => [...values, event])))

      expect(yield* turns.get(Turn.TurnId.make("turn-title-failure"))).toMatchObject({ status: "completed" })
      expect(yield* repository.get(Thread.ThreadId.make("thread-title-failure"))).toMatchObject({
        title: "Stable seed title",
      })
      expect((yield* Ref.get(events)).some((event) => event._tag === "ThreadTitled")).toBe(false)
      expect((yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("does not reclassify a completed turn when thread promotion fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const promotionFailingBackend = ExecutionBackend.Service.of({
        ...backend,
        ensureThreadHost: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "promotion failed" })),
        notifyThreadHost: () => Effect.void,
        registerTurnPromoter: () => Effect.void,
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, promotionFailingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-promotion-failure")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-promotion-failure")),
        interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      yield* session.submit("Completed response", (event) =>
        runSync(Ref.update(events, (values) => [...values, event])),
      )

      expect(yield* turns.get(Turn.TurnId.make("turn-promotion-failure"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("projects interactive backend failures and terminal failure statuses", () =>
    Effect.gen(function* () {
      const runCase = (status: "backend" | "failed" | "failed-event" | "cancelled") =>
        Effect.gen(function* () {
          const repository = yield* ThreadRepository.makeMemory()
          const turns = yield* TurnRepository.makeMemory()
          const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
          const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
          const runSync = Effect.runSyncWith(yield* Effect.context<never>())
          const caseBackend = ExecutionBackend.Service.of({
            ...backend,
            start: (input) =>
              status === "backend"
                ? input.turnId === "turn-backend"
                  ? turns
                      .createForSubmission({
                        id: Turn.TurnId.make("successor-backend"),
                        threadId: Thread.ThreadId.make(input.threadId),
                        prompt: "queued successor",
                        now: 1,
                      })
                      .pipe(
                        Effect.mapError((cause) => ExecutionBackend.BackendError.make({ message: cause.message })),
                        Effect.andThen(
                          Effect.fail(ExecutionBackend.BackendError.make({ message: "interactive backend failed" })),
                        ),
                      )
                  : backend.start(input)
                : Effect.succeed({
                    turnId: input.turnId,
                    status: status === "failed-event" ? ("failed" as const) : status,
                    events:
                      status === "failed-event"
                        ? [
                            {
                              cursor: "failure-cursor",
                              sequence: 1,
                              type: "execution.failed",
                              createdAt: 1,
                              text: "opaque provider failure",
                            },
                          ]
                        : [],
                  }),
          })
          yield* Effect.gen(function* () {
            const operation = yield* Operation.Service
            yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
          }).pipe(
            provideLayer(
              Operation.productLayer({
                repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
                turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
                backendLayer: Layer.succeed(ExecutionBackend.Service, caseBackend),
                defaultWorkspace: "/work",
                makeThreadId: Effect.succeed(Thread.ThreadId.make(`thread-${status}`)),
                makeTurnId: Effect.succeed(Turn.TurnId.make(`turn-${status}`)),
                interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
              }),
            ),
          )
          const session = (yield* Ref.get(sessions))[0]
          if (session === undefined) return yield* Effect.die("Missing interactive session")
          yield* session.submit("prompt", (event) => runSync(Ref.update(events, (values) => [...values, event])))
          return {
            events: yield* Ref.get(events),
            turn: yield* turns.get(Turn.TurnId.make(`turn-${status}`)),
            successor: yield* turns.get(Turn.TurnId.make(`successor-${status}`)),
          }
        })
      const failedBackend = yield* runCase("backend")
      const failed = yield* runCase("failed")
      const failedEvent = yield* runCase("failed-event")
      const cancelled = yield* runCase("cancelled")
      const failedBackendEvent = nonActivation(failedBackend.events).find((event) => event._tag === "ExecutionFailed")
      expect(failedBackendEvent).toMatchObject({ _tag: "ExecutionFailed" })
      expect(failedBackendEvent?._tag === "ExecutionFailed" ? failedBackendEvent.message : undefined).toContain(
        "interactive backend failed",
      )
      expect(failedBackend.turn?.status).toBe("failed")
      expect(failedBackend.successor?.status).toBe("completed")
      expect(nonActivation(failed.events)).toContainEqual({
        _tag: "ExecutionFailed",
        threadId: "thread-failed",
        turnId: "turn-failed",
        message: "Execution failed",
      })
      expect(nonActivation(failedEvent.events)).toContainEqual({
        _tag: "ExecutionEventReceived",
        threadId: "thread-failed-event",
        turnId: "turn-failed-event",
        event: {
          cursor: "failure-cursor",
          sequence: 1,
          type: "execution.failed",
          createdAt: 1,
          text: "opaque provider failure",
        },
      })
      expect(nonActivation(failedEvent.events).some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(nonActivation(cancelled.events)).toContainEqual({
        _tag: "QueueChanged",
        threadId: "thread-cancelled",
        turns: [],
      })
    }),
  )

  it.effect("runs a new thread and persists its terminal turn", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const runningStatuses = yield* Ref.make<ReadonlyArray<Turn.Status>>([])
      const runBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Effect.gen(function* () {
            const turn = yield* turns.get(Turn.TurnId.make(input.turnId)).pipe(Effect.orDie)
            yield* Ref.update(starts, (inputs) => [...inputs, input])
            yield* Ref.update(runningStatuses, (statuses) =>
              turn === undefined ? statuses : [...statuses, turn.status],
            )
            return {
              turnId: input.turnId,
              status: "completed",
              events: [
                { cursor: "cursor-a", sequence: 1, type: "model.output.completed", createdAt: 1 },
                { cursor: "cursor-b", sequence: 2, type: "model.output.completed", createdAt: 2, text: "answer" },
                { cursor: "cursor-c", sequence: 3, type: "execution.completed", createdAt: 3 },
              ],
            }
          }),
      })
      const layer = Layer.mergeAll(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, runBackend),
          defaultWorkspace: "/default-workspace",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-new")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-new")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: [],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      const thread = yield* repository.get(Thread.ThreadId.make("thread-new"))
      const turn = yield* turns.get(Turn.TurnId.make("turn-new"))
      expect(thread).toMatchObject({
        id: "thread-new",
        workspace: "/default-workspace",
        title: "New thread",
      })
      expect(yield* Ref.get(starts)).toMatchObject([
        { threadId: "thread-new", turnId: "turn-new", prompt: "", startedAt: 0 },
      ])
      expect(yield* Ref.get(runningStatuses)).toEqual(["running"])
      expect(turn).toMatchObject({
        id: "turn-new",
        threadId: "thread-new",
        prompt: "",
        status: "completed",
        lastCursor: "cursor-c",
      })
      expect(output.filter((line): line is string => typeof line === "string" && line === "answer")).toEqual(["answer"])
    }),
  )

  it.effect("reuses a requested thread and streams every event as JSON", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-existing"),
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
        Operation.productLayer({
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
        '{"cursor":"cursor-a","sequence":1,"type":"model.output.completed","createdAt":1,"text":"answer"}',
        '{"cursor":"cursor-b","sequence":2,"type":"execution.completed","createdAt":2}',
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
        Operation.productLayer({
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

  it.effect("does not start queued submissions", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-a"),
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
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const starts = yield* Ref.make(0)
      const operationLayer = Operation.productLayer({
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
        Operation.productLayer({
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

  it.effect("pins new executions, resumes pinned executions, and drains multiple queued turns", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("extension-thread"),
        workspace: "/work",
        title: "Extensions",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const pin: ExecutionExtensions.Pin = {
        generation: "generation",
        sourceDigest: "source",
        configFingerprint: "config",
        toolSchemaDigest: "tools",
        mcpFingerprint: "mcp",
        resolvedContextDigest: "context",
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("queued-one"),
          threadId: thread.id,
          prompt: "one",
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("queued-two"),
          threadId: thread.id,
          prompt: "two",
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
          extensionPin: pin,
        },
      ])
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const generation: PluginRegistry.Generation = {
        id: "generation",
        sourceDigest: "source",
        configFingerprint: "config",
        toolSchemaDigest: "tools",
        tools: new Map(),
        modes: new Map(),
        agentProfiles: new Map(),
        uiActions: new Map(),
        diagnostics: [],
      }
      const extensions = ExecutionExtensions.Service.of({
        future: () => Ref.update(calls, (all) => [...all, "future"]).pipe(Effect.as({ pin, generation })),
        resume: (value) =>
          Ref.update(calls, (all) => [...all, `resume:${value.generation}`]).pipe(
            Effect.as({ pin: value, generation }),
          ),
      })
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const runBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (all) => [...all, input]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["initial"],
          threadId: thread.id,
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, runBackend),
            executionExtensions: {
              layer: Layer.succeed(ExecutionExtensions.Service, extensions),
              mcpFingerprint: Effect.succeed("mcp"),
            },
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("initial")),
          }),
        ),
      )
      expect((yield* Ref.get(starts)).map((value) => value.turnId)).toEqual(["queued-one", "queued-two", "initial"])
      expect(yield* Ref.get(calls)).toEqual(["future", "resume:generation", "future"])
    }),
  )

  it.effect("maps extension resume failures and prints empty completed output", () =>
    Effect.gen(function* () {
      const pin: ExecutionExtensions.Pin = {
        generation: "missing",
        sourceDigest: "s",
        configFingerprint: "c",
        toolSchemaDigest: "t",
        mcpFingerprint: "m",
        resolvedContextDigest: "r",
      }
      const extensions = ExecutionExtensions.Service.of({
        future: () => Effect.die("unused"),
        resume: () => Effect.fail(PluginRegistry.GenerationUnavailable.make({ generation: "missing" })),
      })
      const run = (resumeFails: boolean) =>
        Effect.gen(function* () {
          const operation = yield* Operation.Service
          return yield* Effect.result(
            operation.run({
              _tag: "Run",
              prompt: [],
              ephemeral: false,
              streamJson: false,
              streamJsonInput: false,
              streamJsonThinking: false,
            }),
          )
        }).pipe(
          provideLayer(
            Operation.productLayer({
              repositoryLayer: ThreadRepository.memoryLayer(),
              turnRepositoryLayer: TurnRepository.memoryLayer(),
              backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
              defaultWorkspace: "/work",
              makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
              makeTurnId: Effect.succeed(Turn.TurnId.make("turn")),
              ...(resumeFails
                ? {
                    executionExtensions: {
                      layer: Layer.succeed(ExecutionExtensions.Service, extensions),
                      mcpFingerprint: Effect.succeed("m"),
                    },
                  }
                : {}),
            }),
          ),
        )
      expect((yield* run(false))._tag).toBe("Success")
      const existing = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active-pin"),
          threadId: Thread.ThreadId.make("thread"),
          prompt: "resume",
          status: "running",
          createdAt: 1,
          updatedAt: 1,
          extensionPin: pin,
        },
      ])
      const failure = yield* Operation.reconcile(extensions).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(extensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, existing),
            Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
            }),
          ),
        ),
        Effect.result,
      )
      expect(failure._tag).toBe("Failure")
    }),
  )

  it.effect("reconciles pinned missing executions and rejects unpinned extension executions", () =>
    Effect.gen(function* () {
      const pin: ExecutionExtensions.Pin = {
        generation: "g",
        sourceDigest: "s",
        configFingerprint: "c",
        toolSchemaDigest: "t",
        mcpFingerprint: "m",
        resolvedContextDigest: "r",
      }
      const generation: PluginRegistry.Generation = {
        id: "g",
        sourceDigest: "s",
        configFingerprint: "c",
        toolSchemaDigest: "t",
        tools: new Map(),
        modes: new Map(),
        agentProfiles: new Map(),
        uiActions: new Map(),
        diagnostics: [],
      }
      const extensions = ExecutionExtensions.Service.of({
        future: () => Effect.die("unused"),
        resume: (value) => Effect.succeed({ pin: value, generation }),
      })
      const pinned = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("pinned"),
          threadId: Thread.ThreadId.make("thread"),
          prompt: "resume",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
          extensionPin: pin,
          lastCursor: "old",
        },
      ])
      yield* Operation.reconcile(extensions).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(extensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, pinned),
            Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
              start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
            }),
          ),
        ),
      )
      expect(yield* pinned.get(Turn.TurnId.make("pinned"))).toMatchObject({ status: "completed", lastCursor: "old" })
      const unpinned = yield* TurnRepository.makeMemory(
        [
          {
            id: Turn.TurnId.make("unpinned"),
            threadId: Thread.ThreadId.make("thread"),
            prompt: "resume",
            status: "running",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        true,
      )
      yield* Operation.reconcile(extensions).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(extensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, unpinned),
            Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
            }),
          ),
        ),
      )
      expect((yield* unpinned.get(Turn.TurnId.make("unpinned")))?.status).toBe("failed")
    }),
  )

  it.effect("expands existing and missing thread mentions for a run in an explicit workspace", () =>
    Effect.gen(function* () {
      const mentioned: Thread.Thread = {
        id: Thread.ThreadId.make("mentioned"),
        workspace: "/old",
        title: "Mentioned",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const mentionBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(prompts, (all) => [...all, input.prompt]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["compare", "@thread:mentioned", "@thread:missing"],
          workspace: "/explicit",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([mentioned]),
            turnRepositoryLayer: TurnRepository.memoryLayer([
              {
                id: Turn.TurnId.make("history"),
                threadId: mentioned.id,
                prompt: "history",
                status: "completed",
                createdAt: 1,
                updatedAt: 1,
              },
            ]),
            backendLayer: Layer.succeed(ExecutionBackend.Service, mentionBackend),
            defaultWorkspace: "/default",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("created")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("created-turn")),
          }),
        ),
      )
      expect((yield* Ref.get(prompts))[0]).toContain("# Mentioned")
      expect((yield* Ref.get(prompts))[0]).toContain("Thread not found")
    }),
  )

  it.effect("covers thread selection and bounded listing operation branches", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("branch-thread"),
        workspace: "/work",
        title: "Branch",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const layer = Layer.merge(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer([thread]),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("fork")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("fork-turn")),
        }),
      )
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "last" })
        yield* operation.run({ _tag: "Thread", action: "top" })
        yield* operation.run({ _tag: "Thread", action: "list", limit: 1 })
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: thread.id })
      }).pipe(provideLayer(layer))
    }),
  )

  it.effect("interactive promotion fails a legacy queued turn and drains the next routed turn", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interactive-mode"),
        workspace: "/work",
        title: "Interactive mode",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory(
        [
          {
            id: Turn.TurnId.make("history"),
            threadId: thread.id,
            prompt: "history",
            status: "completed",
            createdAt: 2,
            updatedAt: 2,
          },
          {
            id: Turn.TurnId.make("queued"),
            threadId: thread.id,
            prompt: "queued",
            status: "queued",
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        true,
      )
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const modeBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (all) => [...all, String(input.turnId)]).pipe(
            Effect.as({
              turnId: input.turnId,
              status: input.turnId === "queued" ? ("failed" as const) : ("completed" as const),
              events: [],
            }),
          ),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], mode: "high", ephemeral: false })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, modeBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("submitted")),
            interactive: (input, session) =>
              Effect.gen(function* () {
                yield* session.initialize(dispatch)
                yield* session.selectThread(thread.id, dispatch)
                yield* session.submit("submitted", dispatch, input.mode)
              }),
          }),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["submitted"])
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("QueueChanged")
      expect((yield* turns.get(Turn.TurnId.make("queued")))?.status).toBe("failed")
      expect((yield* turns.get(Turn.TurnId.make("submitted")))?.status).toBe("completed")
    }),
  )

  it.effect("pins the selected mode for non-interactive runs and maps workflow defects", () =>
    Effect.gen(function* () {
      const modes = yield* Ref.make<ReadonlyArray<string>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        resolveExecutionRoute: (mode) => {
          runSync(Ref.update(modes, (all) => [...all, mode]))
          return Effect.succeed({
            version: 1,
            mode,
            tokenBudget: 1,
            main: {
              role: "main",
              alias: "test",
              provider: "test",
              model: "test",
              registrationKey: "test",
              gatewayProtocol: "test",
              gatewayBaseUrl: "test://model",
              gatewayAuth: "none",
              effort: "medium",
              fast: false,
              requestVariant: "test",
              compaction: { contextWindow: 10, reserveTokens: 2, keepRecentTokens: 1 },
            },
            oracle: {
              role: "oracle",
              alias: "test",
              provider: "test",
              model: "test",
              registrationKey: "test",
              gatewayProtocol: "test",
              gatewayBaseUrl: "test://model",
              gatewayAuth: "none",
              effort: "medium",
              fast: false,
              requestVariant: "test",
              compaction: { contextWindow: 10, reserveTokens: 2, keepRecentTokens: 1 },
            },
          })
        },
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("mode-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("mode-turn")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["mode"],
          mode: "ultra",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(modes)).toEqual(["ultra"])

      const workflowLayer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(
          ExecutionBackend.Service,
          ExecutionBackend.Service.of({
            ...backend,
            inspectWorkflow: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "workflow failure" })),
          }),
        ),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
      })
      const result = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        const workflow = yield* Effect.result(operation.run({ _tag: "Workflow", action: "inspect", runId: "defect" }))
        const update = yield* Effect.result(operation.run({ _tag: "Update" }))
        const skill = yield* Effect.result(operation.run({ _tag: "Skill", action: "list" }))
        return [workflow, update, skill]
      }).pipe(provideLayer(workflowLayer))
      expect(result.every((value) => value._tag === "Failure")).toBe(true)
    }),
  )
})
