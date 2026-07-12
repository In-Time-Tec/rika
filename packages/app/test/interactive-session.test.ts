import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Effect, Fiber, Layer, Ref } from "effect"
import { Operation } from "../src/index"

const thread = (id: string, updatedAt: number): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: updatedAt,
  updatedAt,
})

const active = (threadId: Thread.ThreadId, id = "active"): Turn.Turn => ({
  id: Turn.TurnId.make(id),
  threadId,
  prompt: "active prompt",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  lastCursor: "active-cursor",
})

const makeHarness = Effect.fn("InteractiveSessionTest.makeHarness")(function* (
  followAfterPermission = false,
  toolApprovalWaitIds: ReadonlyArray<string> = [],
) {
  const older = thread("older", 1)
  const latest = thread("latest", 2)
  const repositories = yield* ThreadRepository.makeMemory([older, latest])
  const turns = yield* TurnRepository.makeMemory([active(older.id), active(latest.id, "latest-active")])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const controls = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
  const record = (...call: ReadonlyArray<unknown>) => Ref.update(controls, (calls) => [...calls, call])
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
      followAfterPermission
        ? Effect.succeed({
            turnId: input.turnId,
            status: "completed" as const,
            events: [{ cursor: "queued-done", sequence: 1, type: "execution.completed", createdAt: 3 }],
          })
        : Effect.die("unused"),
    ...(followAfterPermission
      ? {
          follow: (
            turnId: string,
            afterCursor: string | undefined,
            onEvent?: (event: ExecutionBackend.Event) => void,
          ) => {
            const output = {
              cursor: "resumed-output",
              sequence: 2,
              type: "model.output.completed",
              createdAt: 2,
              text: "created file",
            }
            const completed = { cursor: "resumed-done", sequence: 3, type: "execution.completed", createdAt: 3 }
            onEvent?.(output)
            onEvent?.(completed)
            return record("follow", turnId, afterCursor).pipe(
              Effect.as({ turnId, status: "completed" as const, events: [output, completed] }),
            )
          },
        }
      : {}),
    inspect: (turnId) =>
      Effect.succeed(
        turnId === "recorded-shell"
          ? undefined
          : { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] },
      ),
    steer: (turnId, text, now) => record("steer", turnId, text, now),
    cancel: (turnId, now) =>
      record("cancel", turnId, now).pipe(
        Effect.as({
          turnId,
          status: "cancelled" as const,
          events: [{ cursor: "cancel-cursor", sequence: 1, type: "execution.cancelled", createdAt: now }],
        }),
      ),
    replay: (turnId, cursor) =>
      record("replay", turnId, cursor).pipe(
        Effect.as({ turnId, status: "running" as const, events: [], lastCursor: cursor }),
      ),
    listApprovals: (turnId) =>
      record("list-approvals", turnId).pipe(
        Effect.as(
          toolApprovalWaitIds.map((waitId) => ({
            waitId,
            callId: `call-${waitId}`,
            toolName: "create_file",
            input: { path: "a.ts" },
            requestedAt: 0,
          })),
        ),
      ),
    resolveToolApproval: (waitId, approved, now) => record("tool-approval", waitId, approved, now),
    resolvePermission: (waitId, decision, now) => record("permission", waitId, decision, now),
  })
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.succeed(Turn.TurnId.make("pending")),
    interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
  })
  yield* Effect.gen(function* () {
    const operation = yield* Operation.Service
    yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
  }).pipe(Effect.provide(layer))
  const session = (yield* Ref.get(sessions))[0]
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return { session, repositories, turns, controls, older, latest }
})

describe("InteractiveSession controls", () => {
  it.effect("submits a prompt through every returned session callback", () =>
    Effect.gen(function* () {
      const repositories = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const submittedBackend = ExecutionBackend.Service.of({
        invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        inspect: () => Effect.succeed(undefined),
        start: (input) =>
          Effect.succeed({
            turnId: input.turnId,
            status: "completed" as const,
            events: [
              { cursor: "output", sequence: 1, type: "model.output.completed", createdAt: 1 },
              { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 2 },
            ],
          }),
        replay: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.die("unused"),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, submittedBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("created")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("created-turn")),
        interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(Effect.provide(layer))
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.submit("", (event) => events.push(event))
      expect(events).toEqual([
        { _tag: "ThreadActivated", threadId: "created", title: "New thread" },
        {
          _tag: "TurnStarted",
          threadId: "created",
          turn: expect.objectContaining({ id: "created-turn", threadId: "created", prompt: "", status: "accepted" }),
        },
        {
          _tag: "ExecutionEventReceived",
          threadId: "created",
          turnId: "created-turn",
          event: { cursor: "output", sequence: 1, type: "model.output.completed", createdAt: 1 },
        },
        {
          _tag: "ExecutionEventReceived",
          threadId: "created",
          turnId: "created-turn",
          event: { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 2 },
        },
        { _tag: "QueueChanged", threadId: "created", turns: [] },
      ])
      expect(yield* repositories.get(Thread.ThreadId.make("created"))).toMatchObject({ title: "New thread" })
      expect(yield* turns.get(Turn.TurnId.make("created-turn"))).toMatchObject({
        status: "completed",
        lastCursor: "done",
      })
    }),
  )

  it.effect("edits and dequeues queued turns and reports the remaining queue", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* turns.createForSubmission({ id: Turn.TurnId.make("queued"), threadId: older.id, prompt: "before", now: 2 })
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      yield* session.editQueued("queued", "after", (event) => events.push(event))
      expect((yield* turns.get(Turn.TurnId.make("queued")))?.prompt).toBe("after")
      expect(events.at(-1)).toMatchObject({ _tag: "QueueChanged", turns: [{ id: "queued", prompt: "after" }] })
      yield* session.dequeue("queued", (event) => events.push(event))
      expect(yield* turns.get(Turn.TurnId.make("queued"))).toBeUndefined()
      expect(events.at(-1)).toEqual({ _tag: "QueueChanged", threadId: "older", turns: [] })
    }),
  )

  it.effect("steers and cancels the selected active turn", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      yield* session.steer("change course", (event) => events.push(event))
      yield* session.cancel((event) => events.push(event))
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["steer", "active", "change course", 0],
        ["cancel", "active", 0],
      ])
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancel-cursor",
      })
      expect(events.slice(-2)).toEqual([
        { _tag: "ExecutionControlled", threadId: "older", turnId: "active", action: "cancelled" },
        { _tag: "QueueChanged", threadId: "older", turns: [] },
      ])
    }),
  )

  it.effect("persists interrupt-and-send before cancelling the active turn", () =>
    Effect.gen(function* () {
      const { turns, controls, older } = yield* makeHarness()
      const persistedAtCancel = yield* Ref.make<Turn.Turn | undefined>(undefined)
      const checkingBackend = ExecutionBackend.Service.of({
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
            status: "completed" as const,
            events: [{ cursor: "replacement-done", sequence: 1, type: "execution.completed", createdAt: 4 }],
          }),
        replay: (turnId) => Effect.succeed({ turnId, status: "running", events: [] }),
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        steer: () => Effect.void,
        cancel: (turnId) =>
          turns.get(Turn.TurnId.make("pending")).pipe(
            Effect.orDie,
            Effect.flatMap((pending) => Ref.set(persistedAtCancel, pending)),
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.void,
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([older]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, checkingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.succeed(Turn.TurnId.make("pending")),
        interactive: (_, value) => Ref.update(sessions, (values) => [...values, value]),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(Effect.provide(layer))
      const checkingSession = (yield* Ref.get(sessions))[0]
      if (checkingSession === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* checkingSession.selectThread(older.id, (event) => events.push(event))
      yield* checkingSession.interruptAndSend("next prompt", (event) => events.push(event))
      expect(yield* Ref.get(persistedAtCancel)).toMatchObject({ prompt: "next prompt", status: "queued" })
      expect((yield* turns.get(Turn.TurnId.make("active")))?.status).toBe("cancelled")
      expect(yield* turns.get(Turn.TurnId.make("pending"))).toMatchObject({
        status: "completed",
        lastCursor: "replacement-done",
      })
      expect(events.at(-1)?._tag).toBe("QueueChanged")
      expect(yield* Ref.get(controls)).toEqual([])
    }),
  )

  it.effect("maps allow, deny, and always permission decisions", () =>
    Effect.gen(function* () {
      const { session, controls } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread("older", (event) => events.push(event))
      yield* Ref.set(controls, [])
      events.length = 0
      yield* session.resolvePermission("allow-wait", "permission", "allow", (event) => events.push(event))
      yield* session.resolvePermission("deny-wait", "permission", "deny", (event) => events.push(event))
      yield* session.resolvePermission("always-wait", "permission", "always", (event) => events.push(event))
      expect(yield* Ref.get(controls)).toEqual([
        ["permission", "allow-wait", "Approved", 0],
        ["permission", "deny-wait", "Denied", 0],
        ["permission", "always-wait", "Always", 0],
      ])
      expect(events).toHaveLength(3)
      expect(
        events.every((event) => event._tag === "ExecutionControlled" && event.action === "permission-resolved"),
      ).toBe(true)
    }),
  )

  it.effect("resolves pending tool approvals through the tool approval endpoint", () =>
    Effect.gen(function* () {
      const { session, controls } = yield* makeHarness(false, ["allow-tool", "always-tool", "deny-tool"])
      const events: Array<Operation.InteractiveEvent> = []
      const dispatch = (event: Operation.InteractiveEvent) => events.push(event)
      yield* session.selectThread("older", dispatch)
      yield* Ref.set(controls, [])
      yield* session.resolvePermission("allow-tool", "tool-approval", "allow", dispatch)
      yield* session.resolvePermission("always-tool", "tool-approval", "always", dispatch)
      yield* session.resolvePermission("deny-tool", "tool-approval", "deny", dispatch)
      expect(yield* Ref.get(controls)).toEqual([
        ["tool-approval", "allow-tool", true, 0],
        ["tool-approval", "always-tool", true, 0],
        ["tool-approval", "deny-tool", false, 0],
      ])
    }),
  )

  it.effect("follows an approved durable permission through completion and drains the queue", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness(true)
      yield* turns.setStatus(Turn.TurnId.make("active"), "waiting", "wait-cursor", 2)
      yield* turns.createForSubmission({
        id: Turn.TurnId.make("queued-after-wait"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 3,
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      yield* session.resolvePermission("permission-wait", "permission", "allow", (event) => events.push(event))
      expect(yield* Ref.get(controls)).toContainEqual(["follow", "active", "wait-cursor"])
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({
        status: "completed",
        lastCursor: "resumed-done",
      })
      expect(yield* turns.get(Turn.TurnId.make("queued-after-wait"))).toMatchObject({
        status: "completed",
        lastCursor: "queued-done",
      })
      expect(events).toContainEqual({
        _tag: "ExecutionEventReceived",
        threadId: "older",
        turnId: "active",
        event: expect.objectContaining({ type: "model.output.completed", text: "created file" }),
      })
      expect(events).toContainEqual({
        _tag: "ExecutionEventReceived",
        threadId: "older",
        turnId: "active",
        event: expect.objectContaining({ cursor: "resumed-done", type: "execution.completed" }),
      })
    }),
  )

  it.effect(
    "persists approved shell output, keeps incognito output transient, denies execution, and queues while busy",
    () =>
      Effect.gen(function* () {
        const repositories = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
        const commands = yield* Ref.make<ReadonlyArray<string>>([])
        let turnNumber = 0
        const layer = Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(
            ExecutionBackend.Service,
            ExecutionBackend.Service.of({
              invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
              createFanOut: () => Effect.die("unused"),
              inspectFanOut: () => Effect.die("unused"),
              cancelFanOut: () => Effect.die("unused"),
              registerWorkflows: () => Effect.die("unused"),
              startWorkflow: () => Effect.die("unused"),
              inspectWorkflow: () => Effect.die("unused"),
              cancelWorkflow: () => Effect.die("unused"),
              start: () => Effect.die("unused"),
              inspect: () => Effect.succeed(undefined),
              replay: () => Effect.die("unused"),
              steer: () => Effect.die("unused"),
              cancel: () => Effect.die("unused"),
              listApprovals: () => Effect.succeed([]),
              resolveToolApproval: () => Effect.void,
              resolvePermission: () => Effect.die("unused"),
            }),
          ),
          toolRuntimeLayer: () =>
            ToolRuntime.testLayer((request) => {
              const command = request._tag === "Shell" ? request.args.join(" ") : request._tag
              return Ref.update(commands, (values) => [...values, command]).pipe(
                Effect.as({ text: `output:${command}`, truncated: false }),
              )
            }),
          defaultWorkspace: "/work",
          shellPermission: "ask",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
          makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${turnNumber++}`)),
          interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
        }).pipe(Effect.provide(layer))
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("Missing interactive session")

        const runShell = Effect.fn("InteractiveSessionTest.runShell")(function* (
          command: string,
          incognito: boolean,
          decision: "allow" | "deny" | "always",
        ) {
          const events: Array<Operation.InteractiveEvent> = []
          const fiber = yield* Effect.forkChild(session.shell(command, incognito, (event) => events.push(event)))
          yield* Effect.yieldNow
          const permission = events.find((event) => event._tag === "ShellPermissionRequested")
          if (permission?._tag !== "ShellPermissionRequested") return yield* Effect.die("Missing shell permission")
          yield* session.resolvePermission(permission.id, "permission", decision, (event) => events.push(event))
          yield* Fiber.join(fiber)
          return events
        })

        const persisted = yield* runShell("printf persisted", false, "allow")
        expect(persisted.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: false })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread")))[0]).toMatchObject({
          prompt: expect.stringContaining("output:-lc printf persisted"),
          status: "completed",
        })

        const beforeIncognito = (yield* turns.list(Thread.ThreadId.make("shell-thread"))).length
        const incognito = yield* runShell("printf secret", true, "always")
        expect(incognito.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: true })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread"))).length).toBe(beforeIncognito)

        const denied = yield* runShell("printf denied", false, "deny")
        expect(denied.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
          message: "Shell command denied",
        })
        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted", "-lc printf secret"])

        yield* turns.createForSubmission({
          id: Turn.TurnId.make("active-shell-blocker"),
          threadId: Thread.ThreadId.make("shell-thread"),
          prompt: "active",
          now: 2,
        })
        const queued = yield* runShell("printf queued", false, "allow")
        expect(queued.findLast((event) => event._tag === "QueueChanged")).toMatchObject({
          turns: [{ status: "queued" }],
        })
        expect(
          (yield* turns.list(Thread.ThreadId.make("shell-thread"))).find((turn) =>
            turn.prompt.startsWith("$ printf queued"),
          ),
        ).toMatchObject({ status: "queued" })
      }),
  )

  it.effect("selects a thread, reopens the latest thread, and replays after the requested cursor", () =>
    Effect.gen(function* () {
      const { session, controls, older } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      yield* session.reopenThread((event) => events.push(event))
      yield* session.replay("latest-active", "cursor-7", (event) => events.push(event))
      expect(events[0]).toMatchObject({ _tag: "ThreadSelected", thread: { id: "older" }, turns: [{ id: "active" }] })
      expect(events.find((event) => event._tag === "ThreadSelected" && event.thread.id === "latest")).toMatchObject({
        _tag: "ThreadSelected",
        thread: { id: "latest" },
        turns: [{ id: "latest-active" }],
      })
      expect(events.findLast((event) => event._tag === "ExecutionReplayed")).toMatchObject({
        _tag: "ExecutionReplayed",
        result: { turnId: "latest-active", lastCursor: "cursor-7" },
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["replay", "latest-active", undefined],
        ["replay", "latest-active", "cursor-7"],
      ])
    }),
  )

  it.effect("replays only existing executions and still emits the queued turns when selecting a thread", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const queued = yield* turns.createForSubmission({
        id: Turn.TurnId.make("queued-selection"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 2,
      })
      const shell = yield* turns.createForSubmission({
        id: Turn.TurnId.make("recorded-shell"),
        threadId: older.id,
        prompt: "$ printf recorded\n\noutput:recorded",
        now: 3,
      })
      yield* turns.setStatus(shell.id, "completed", undefined, 4)
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 5)
      const events: Array<Operation.InteractiveEvent> = []

      yield* session.selectThread(older.id, (event) => events.push(event))

      expect(events.find((event) => event._tag === "QueueChanged")).toMatchObject({
        _tag: "QueueChanged",
        turns: [{ id: queued.id, status: "queued" }],
      })
      expect(events.filter((event) => event._tag === "ExecutionReplayed")).toHaveLength(2)
      expect(events.findLast((event) => event._tag === "ExecutionReplayed")).toMatchObject({
        result: { turnId: shell.id, status: "completed", events: [] },
      })
      expect(yield* Ref.get(controls)).toEqual([["replay", "active", undefined]])
    }),
  )

  it.effect("projects control failures instead of failing the session effect", () =>
    Effect.gen(function* () {
      const { session } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread("missing", (event) => events.push(event))
      yield* session.steer("nowhere", (event) => events.push(event))
      yield* session.editQueued("missing", "no", (event) => events.push(event))
      expect(events).toHaveLength(3)
      expect(events.every((event) => event._tag === "ExecutionFailed")).toBe(true)
      expect(events[0]).toMatchObject({ message: expect.stringContaining("Thread missing does not exist") })
      expect(events[1]).toMatchObject({ message: expect.stringContaining("No thread selected") })
      expect(events[2]).toMatchObject({ message: expect.stringContaining("is not queued") })
    }),
  )
})
