import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Effect, Fiber, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "../src/index"
import { provideLayer } from "./layer"

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
  followAfterPermission: boolean = false,
  toolApprovalWaitIds: ReadonlyArray<string> = [],
  pagedEvents?: ReadonlyArray<ExecutionBackend.Event>,
  stalePageCursor: boolean = false,
) {
  const older = thread("older", 1)
  const latest = thread("latest", 2)
  const repositories = yield* ThreadRepository.makeMemory([older, latest])
  const turns = yield* TurnRepository.makeMemory([active(older.id), active(latest.id, "latest-active")])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const controls = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
  const hiddenExecutions = yield* Ref.make<ReadonlySet<string>>(new Set())
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
      Ref.get(hiddenExecutions).pipe(
        Effect.map((hidden) =>
          turnId === "recorded-shell" || hidden.has(turnId)
            ? undefined
            : { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] },
        ),
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
    ...(pagedEvents === undefined
      ? {}
      : {
          pageEvents: (turnId: string, direction: "forward" | "backward", cursor?: string, limit = 200) => {
            const boundary =
              cursor === undefined
                ? direction === "forward"
                  ? 0
                  : pagedEvents.length
                : pagedEvents.findIndex((event) => event.cursor === cursor) + (direction === "forward" ? 1 : 0)
            const page =
              direction === "forward"
                ? pagedEvents.slice(boundary, boundary + limit)
                : pagedEvents.slice(Math.max(0, boundary - limit), boundary)
            const hasMore =
              direction === "forward" ? boundary + page.length < pagedEvents.length : boundary > page.length
            return record("page", turnId, direction, cursor, limit).pipe(
              Effect.as({
                events: page,
                hasMore,
                ...(page[0] === undefined
                  ? {}
                  : {
                      oldestCursor:
                        direction === "backward" && stalePageCursor && cursor !== undefined ? cursor : page[0].cursor,
                    }),
                ...(page.at(-1) === undefined
                  ? {}
                  : {
                      newestCursor:
                        direction === "forward" && stalePageCursor && cursor !== undefined
                          ? cursor
                          : page.at(-1)!.cursor,
                    }),
              }),
            )
          },
        }),
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
  }).pipe(provideLayer(layer))
  const session = (yield* Ref.get(sessions))[0]
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return { session, repositories, turns, controls, hiddenExecutions, older, latest }
})

describe("InteractiveSession controls", () => {
  it.effect("publishes live thread summaries and clears unread state when a thread is selected", () =>
    Effect.gen(function* () {
      const { session, older } = yield* makeHarness()
      const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
      const watcher = yield* Effect.forkChild(session.watchThreads((event) => Queue.offerUnsafe(events, event)))
      const initial = yield* Queue.take(events)
      expect(initial).toMatchObject({
        _tag: "ThreadsListed",
        threads: expect.arrayContaining([
          expect.objectContaining({ id: "older", status: "running", unread: true }),
          expect.objectContaining({ id: "latest", status: "running", unread: true }),
        ]),
      })
      yield* TestClock.adjust("10 millis")
      yield* session.selectThread(older.id, () => undefined)
      let selected = yield* Queue.take(events)
      while (
        selected._tag !== "ThreadsListed" ||
        selected.threads.find((item) => item.id === older.id)?.unread !== false
      )
        selected = yield* Queue.take(events)
      expect(selected).toMatchObject({
        _tag: "ThreadsListed",
        threads: expect.arrayContaining([expect.objectContaining({ id: "older", unread: false })]),
      })
      yield* Fiber.interrupt(watcher)
    }),
  )

  it.effect("keeps simultaneous interactive sessions independent and uses each request workspace", () =>
    Effect.gen(function* () {
      const repositories = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = new Map<string, Operation.InteractiveSession>()
      const toolWorkspaces: Array<string> = []
      const threadSequence = yield* Ref.make(0)
      const turnSequence = yield* Ref.make(0)
      const backend = ExecutionBackend.Service.of({
        invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        inspect: () => Effect.void.pipe(Effect.as(undefined)),
        start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed" as const, events: [] }),
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
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        toolRuntimeLayer: (workspace) => {
          toolWorkspaces.push(workspace)
          return ToolRuntime.testLayer(() => Effect.succeed({ text: workspace, truncated: false }))
        },
        defaultWorkspace: "/default",
        makeThreadId: Ref.updateAndGet(threadSequence, (value) => value + 1).pipe(
          Effect.map((value) => Thread.ThreadId.make(`thread-${value}`)),
        ),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: (input, session) => Effect.sync(() => sessions.set(input.workspace ?? "/default", session)),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* Effect.all(
          [
            operation.run({ _tag: "Interactive", prompt: [], workspace: "/alpha", ephemeral: false }),
            operation.run({ _tag: "Interactive", prompt: [], workspace: "/beta", ephemeral: false }),
          ],
          { concurrency: "unbounded" },
        )
      }).pipe(provideLayer(layer))
      const alpha = sessions.get("/alpha")
      const beta = sessions.get("/beta")
      if (alpha === undefined || beta === undefined) return yield* Effect.die("Missing interactive sessions")
      const alphaEvents: Array<Operation.InteractiveEvent> = []
      const betaEvents: Array<Operation.InteractiveEvent> = []
      yield* Effect.all(
        [
          alpha.submit("alpha prompt", (event) => alphaEvents.push(event)),
          beta.submit("beta prompt", (event) => betaEvents.push(event)),
        ],
        { concurrency: "unbounded" },
      )
      yield* Effect.all([
        alpha.shell("pwd", true, (event) => alphaEvents.push(event)),
        beta.shell("pwd", true, (event) => betaEvents.push(event)),
      ])
      const alphaThreadId = alphaEvents.find((event) => event._tag === "ThreadActivated")?.threadId
      const betaThreadId = betaEvents.find((event) => event._tag === "ThreadActivated")?.threadId
      expect(alphaThreadId).not.toBe(betaThreadId)
      yield* Effect.all([
        alpha.selectThread(alphaThreadId!, (event) => alphaEvents.push(event)),
        beta.selectThread(betaThreadId!, (event) => betaEvents.push(event)),
      ])
      yield* Effect.all([
        alpha.submit("alpha follow-up", (event) => alphaEvents.push(event)),
        beta.submit("beta follow-up", (event) => betaEvents.push(event)),
      ])
      expect((yield* repositories.get(Thread.ThreadId.make(alphaThreadId!)))?.workspace).toBe("/alpha")
      expect((yield* repositories.get(Thread.ThreadId.make(betaThreadId!)))?.workspace).toBe("/beta")
      expect((yield* turns.list(Thread.ThreadId.make(alphaThreadId!))).map((turn) => turn.prompt)).toEqual([
        "alpha prompt",
        "alpha follow-up",
      ])
      expect((yield* turns.list(Thread.ThreadId.make(betaThreadId!))).map((turn) => turn.prompt)).toEqual([
        "beta prompt",
        "beta follow-up",
      ])
      expect(toolWorkspaces.toSorted()).toEqual(["/alpha", "/beta"])
    }),
  )

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
        inspect: () => Effect.void.pipe(Effect.as(undefined)),
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
      }).pipe(provideLayer(layer))
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
          _tag: "TranscriptPatched",
          threadId: "created",
          turnId: "created-turn",
          revision: 1,
          event: { cursor: "output", sequence: 1, type: "model.output.completed", createdAt: 1 },
        },
        {
          _tag: "TranscriptPatched",
          threadId: "created",
          turnId: "created-turn",
          revision: 2,
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
      expect(events.at(-2)).toEqual({
        _tag: "QueuedTurnEdited",
        threadId: "older",
        turnId: "queued",
        prompt: "after",
      })
      expect(events.at(-1)).toMatchObject({ _tag: "QueueChanged", turns: [{ id: "queued", prompt: "after" }] })
      events.length = 0
      yield* session.selectThread(older.id, (event) => events.push(event))
      const page = events.find((event) => event._tag === "TranscriptPageReceived")
      expect(
        page?._tag === "TranscriptPageReceived"
          ? page.entries.find((entry) => entry.turn.id === "queued")?.unit.content
          : undefined,
      ).toEqual({ _tag: "Entry", role: "user", text: "after" })
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
      }).pipe(provideLayer(layer))
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
      const priorOutput = {
        cursor: "prior-output",
        sequence: 0,
        type: "model.output.completed",
        createdAt: 1,
        text: "work before permission",
      }
      const priorPermission = {
        cursor: "permission-wait",
        sequence: 1,
        type: "permission.ask.requested",
        createdAt: 1,
        data: { wait_id: "permission-wait", title: "Allow work" },
      }
      const { session, turns, controls, older } = yield* makeHarness(true, [], [priorOutput, priorPermission])
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
        _tag: "TranscriptPatched",
        threadId: "older",
        turnId: "active",
        revision: expect.any(Number),
        event: expect.objectContaining({ type: "model.output.completed", text: "created file" }),
      })
      expect(events).toContainEqual({
        _tag: "TranscriptPatched",
        threadId: "older",
        turnId: "active",
        revision: expect.any(Number),
        event: expect.objectContaining({ cursor: "resumed-done", type: "execution.completed" }),
      })
      events.length = 0
      yield* session.selectThread(older.id, (event) => events.push(event))
      const page = events.find((event) => event._tag === "TranscriptPageReceived")
      expect(page?._tag === "TranscriptPageReceived" ? page.entries : []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            unit: expect.objectContaining({
              content: expect.objectContaining({ _tag: "Entry", text: "work before permission" }),
            }),
          }),
          expect.objectContaining({
            unit: expect.objectContaining({
              content: expect.objectContaining({ _tag: "Entry", text: "created file" }),
            }),
          }),
        ]),
      )
    }),
  )

  it.effect("keeps following a selected thread when another session starts a later turn", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness(true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      const follower = yield* Effect.forkChild(session.followSelected((event) => events.push(event)))
      yield* Effect.yieldNow
      expect(yield* Ref.get(controls)).toContainEqual(["follow", "active", "active-cursor"])

      yield* turns.createForSubmission({
        id: Turn.TurnId.make("later"),
        threadId: older.id,
        prompt: "later prompt",
        now: 4,
      })
      yield* turns.setStatus(Turn.TurnId.make("later"), "running", undefined, 5)
      yield* TestClock.adjust("100 millis")
      yield* Effect.yieldNow

      expect(yield* Ref.get(controls)).toContainEqual(["follow", "later", undefined])
      expect(events).toContainEqual({
        _tag: "TurnStarted",
        threadId: "older",
        turn: expect.objectContaining({ id: "later", prompt: "later prompt" }),
      })
      yield* Fiber.interrupt(follower)
    }),
  )

  it.effect("waits for an accepted turn execution to become visible before following", () =>
    Effect.gen(function* () {
      const { session, turns, controls, hiddenExecutions, older } = yield* makeHarness(true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      const follower = yield* Effect.forkChild(session.followSelected((event) => events.push(event)))
      yield* Effect.yieldNow

      yield* Ref.set(hiddenExecutions, new Set(["later-accepted"]))
      yield* turns.createForSubmission({
        id: Turn.TurnId.make("later-accepted"),
        threadId: older.id,
        prompt: "accepted elsewhere",
        now: 6,
      })
      yield* TestClock.adjust("100 millis")
      yield* Effect.yieldNow

      expect(yield* Ref.get(controls)).not.toContainEqual(["follow", "later-accepted", undefined])
      expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(false)

      yield* Ref.set(hiddenExecutions, new Set())
      yield* TestClock.adjust("100 millis")
      yield* Effect.yieldNow

      expect(yield* Ref.get(controls)).toContainEqual(["follow", "later-accepted", undefined])
      yield* Fiber.interrupt(follower)
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
        const permissionWorkspaces = yield* Ref.make<ReadonlyArray<string>>([])
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
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
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
          shellPermission: (workspace) =>
            Ref.update(permissionWorkspaces, (values) => [...values, workspace]).pipe(Effect.as("ask" as const)),
          makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
          makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${turnNumber++}`)),
          interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false, workspace: "/client-shell" })
        }).pipe(provideLayer(layer))
        expect(yield* Ref.get(permissionWorkspaces)).toContain("/client-shell")
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
      expect(events[0]).toMatchObject({
        _tag: "TranscriptPageReceived",
        thread: { id: "older" },
        entries: [{ turn: { id: "active" } }],
      })
      expect(
        events.find((event) => event._tag === "TranscriptPageReceived" && event.thread.id === "latest"),
      ).toMatchObject({
        _tag: "TranscriptPageReceived",
        thread: { id: "latest" },
        entries: [{ turn: { id: "latest-active" } }],
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

  it.effect("projects one Turn incrementally from bounded forward event pages", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): ExecutionBackend.Event => ({
          cursor: `cursor-${index + 1}`,
          sequence: index + 1,
          type: "model.output.completed",
          createdAt: index + 1,
          text: `event ${index + 1}`,
        }),
      )
      const { session, controls, older } = yield* makeHarness(false, [], pagedEvents)
      const events: Array<Operation.InteractiveEvent> = []

      yield* session.selectThread(older.id, (event) => events.push(event))

      const received = events.find((event) => event._tag === "TranscriptPageReceived")
      const projected =
        received?._tag === "TranscriptPageReceived"
          ? received.entries.filter((entry) => entry.turn.id === "active")
          : []
      expect(projected).toHaveLength(2)
      expect(projected.at(-1)?.unit).toMatchObject({
        revision: 450,
        content: { _tag: "Entry", role: "assistant", text: "event 450" },
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
        ["page", "active", "forward", "cursor-400", 200],
      ])
    }),
  )

  it.effect("fails transcript loading when forward paging stops advancing", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): ExecutionBackend.Event => ({
          cursor: `cursor-${index + 1}`,
          sequence: index + 1,
          type: "model.output.completed",
          createdAt: index + 1,
          text: `event ${index + 1}`,
        }),
      )
      const { session, controls, older } = yield* makeHarness(false, [], pagedEvents, true)
      const events: Array<Operation.InteractiveEvent> = []

      yield* session.selectThread(older.id, (event) => events.push(event))

      expect(events.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
        message: expect.stringContaining("cursor did not advance"),
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
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
      expect(events.find((event) => event._tag === "TranscriptPageReceived")).toMatchObject({
        entries: [
          { turn: { id: "active" }, unit: { content: { _tag: "Entry" } } },
          { turn: { id: queued.id, status: "queued" }, unit: { content: { _tag: "Entry" } } },
          { turn: { id: shell.id, status: "completed" }, unit: { content: { _tag: "Entry" } } },
        ],
      })
      expect(yield* Ref.get(controls)).toEqual([["replay", "active", undefined]])
    }),
  )

  it.effect("loads only the newest fifty turns and prepends older pages on demand", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      for (let index = 0; index < 60; index += 1) {
        const created = yield* turns.createForSubmission({
          id: Turn.TurnId.make(`history-${index.toString().padStart(2, "0")}`),
          threadId: older.id,
          prompt: `history ${index}`,
          now: index + 10,
        })
        yield* turns.setStatus(created.id, "completed", undefined, index + 10)
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* session.selectThread(older.id, (event) => events.push(event))
      const initial = events.find((event) => event._tag === "TranscriptPageReceived")
      yield* session.loadOlder((event) => events.push(event))
      expect(initial?._tag === "TranscriptPageReceived" ? initial.hasOlder : false).toBe(true)
      expect(initial?._tag === "TranscriptPageReceived" ? initial.entries : []).toHaveLength(50)
      expect(
        initial?._tag === "TranscriptPageReceived" ? initial.entries.map((entry) => entry.turn.id).at(-1) : undefined,
      ).toBe(Turn.TurnId.make("history-59"))
      const prepended = events.find((event) => event._tag === "TranscriptPagePrepended")
      expect(prepended?._tag === "TranscriptPagePrepended" ? prepended.hasOlder : true).toBe(false)
      expect(
        prepended?._tag === "TranscriptPagePrepended" ? prepended.entries.map((entry) => entry.turn.id) : [],
      ).toEqual([
        Turn.TurnId.make("active"),
        ...Array.from({ length: 10 }, (_, index) => Turn.TurnId.make(`history-${index.toString().padStart(2, "0")}`)),
      ])
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
