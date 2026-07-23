import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "../src/index"
import { createTurn, executionRoute } from "./current-state"

const collectEvents = (session: Operation.InteractiveSession, events: Array<Operation.InteractiveEvent>) =>
  Effect.forkChild(session.events((event) => events.push(event))).pipe(Effect.andThen(Effect.yieldNow))

const waitForSessions = (sessions: Ref.Ref<ReadonlyArray<Operation.InteractiveSession>>, count = 1) =>
  Effect.gen(function* () {
    while ((yield* Ref.get(sessions)).length < count) yield* Effect.yieldNow
  })

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
  executionRoute: executionRoute(),
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
  const permissionResolved = yield* Deferred.make<void>()
  const hiddenExecutions = yield* Ref.make<ReadonlySet<string>>(new Set())
  const transcripts = Context.get(yield* Layer.build(TranscriptRepository.memoryLayer), TranscriptRepository.Service)
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
        ? record("start", input.turnId).pipe(
            Effect.as({
              turnId: input.turnId,
              status: "completed" as const,
              events: [{ cursor: "queued-done", sequence: 1, type: "execution.completed", createdAt: 3 }],
            }),
          )
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
            return record("follow", turnId, afterCursor).pipe(
              Effect.andThen(turnId === "active" ? Deferred.await(permissionResolved) : Effect.void),
              Effect.tap(() => Effect.sync(() => onEvent?.(output))),
              Effect.tap(() => Effect.sync(() => onEvent?.(completed))),
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
    steer: (turnId, text, now) =>
      record("steer", turnId, text, now).pipe(
        Effect.as({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
      ),
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
            let boundary: number
            if (cursor === undefined) {
              boundary = direction === "forward" ? 0 : pagedEvents.length
            } else {
              boundary = pagedEvents.findIndex((event) => event.cursor === cursor)
              if (direction === "forward") boundary += 1
            }
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
            toolName: "write",
            input: { path: "a.ts" },
            requestedAt: 0,
          })),
        ),
      ),
    resolveToolApproval: (waitId, approved, now) => record("tool-approval", waitId, approved, now),
    resolvePermission: (waitId, decision, now) =>
      record("permission", waitId, decision, now).pipe(Effect.andThen(Deferred.succeed(permissionResolved, undefined))),
  })
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.succeed(Turn.TurnId.make("pending")),
    interactive: (_, session) =>
      Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
  })
  const context = yield* Layer.build(layer)
  const operation = Context.get(context, Operation.Service)
  yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
  yield* waitForSessions(sessions)
  yield* Ref.set(controls, [])
  const session = (yield* Ref.get(sessions))[0]
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return { session, repositories, turns, transcripts, controls, hiddenExecutions, older, latest }
})

describe("InteractiveSession controls", () => {
  it.effect("publishes live thread summaries and clears unread state when a thread is selected", () =>
    Effect.gen(function* () {
      const { session, older } = yield* makeHarness()
      const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
      const watcher = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))
      const initial = yield* Queue.take(events)
      expect(initial).toMatchObject({
        _tag: "ThreadsListed",
        threads: expect.arrayContaining([
          expect.objectContaining({ id: "older", status: "running", unread: true }),
          expect.objectContaining({ id: "latest", status: "running", unread: true }),
        ]),
      })
      yield* TestClock.adjust("10 millis")
      yield* session.selectThread(older.id, 3)
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
        replay: (turnId, cursor) =>
          Effect.succeed({ turnId, status: "completed" as const, events: [], lastCursor: cursor }),
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
        interactive: (input, session) =>
          Effect.sync(() => sessions.set(input.workspace ?? "/default", session)).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(
        Effect.all(
          [
            operation.run({ _tag: "Interactive", prompt: [], workspace: "/alpha", ephemeral: false }),
            operation.run({ _tag: "Interactive", prompt: [], workspace: "/beta", ephemeral: false }),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      )
      while (sessions.size < 2) yield* Effect.yieldNow
      const alpha = sessions.get("/alpha")
      const beta = sessions.get("/beta")
      if (alpha === undefined || beta === undefined) return yield* Effect.die("Missing interactive sessions")
      const alphaEvents: Array<Operation.InteractiveEvent> = []
      const betaEvents: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(alpha, alphaEvents)
      yield* collectEvents(beta, betaEvents)
      yield* Effect.all([alpha.submit("alpha prompt"), beta.submit("beta prompt")], { concurrency: "unbounded" })
      yield* Effect.all([alpha.shell("pwd", true), beta.shell("pwd", true)])
      const alphaThreadId = alphaEvents.find((event) => event._tag === "ThreadActivated")?.threadId
      const betaThreadId = betaEvents.find((event) => event._tag === "ThreadActivated")?.threadId
      expect(alphaThreadId).not.toBe(betaThreadId)
      yield* Effect.all([alpha.selectThread(alphaThreadId!, 1), beta.selectThread(betaThreadId!, 1)])
      yield* Effect.all([alpha.submit("alpha follow-up"), beta.submit("beta follow-up")])
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
        interactive: (_, session) =>
          Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.reopenThread(1)
      yield* session.submit("")
      while ((yield* turns.get(Turn.TurnId.make("created-turn")))?.status !== "completed") yield* Effect.yieldNow
      while (events.filter((event) => event._tag !== "ThreadsListed").length < 5) yield* Effect.yieldNow
      expect(events.filter((event) => event._tag !== "ThreadsListed")).toEqual([
        { _tag: "ThreadActivated", threadId: "created", title: "New thread" },
        {
          _tag: "SubmissionAdmitted",
          selectionEpoch: 0,
          threadId: "created",
          turnId: "created-turn",
          status: "active",
        },
        {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: "created",
          turn: expect.objectContaining({ id: "created-turn", threadId: "created", prompt: "", status: "running" }),
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "created",
          turnId: "created-turn",
          revision: 1,
          event: { cursor: "output", sequence: 1, type: "model.output.completed", createdAt: 1 },
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "created",
          turnId: "created-turn",
          revision: 2,
          event: { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 2 },
        },
      ])
      expect(yield* repositories.get(Thread.ThreadId.make("created"))).toMatchObject({ title: "New thread" })
      expect(yield* turns.get(Turn.TurnId.make("created-turn"))).toMatchObject({
        status: "completed",
        lastCursor: "done",
      })
    }),
  )

  it.effect("admits, edits, and dequeues pending turns while the active turn is still executing", () =>
    Effect.gen(function* () {
      const repositories = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const nextTurn = yield* Ref.make(0)
      const activeStarted = yield* Deferred.make<void>()
      const activeSubmitted = yield* Deferred.make<void>()
      const releaseActive = yield* Deferred.make<void>()
      const pendingStarted = yield* Deferred.make<void>()
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
        start: (input) =>
          input.turnId === "turn-0"
            ? Deferred.succeed(activeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseActive)),
                Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
              )
            : Deferred.succeed(pendingStarted, undefined).pipe(
                Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
              ),
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
        defaultWorkspace: "/work",
        pendingTurnCapacity: 2,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
        makeTurnId: Ref.getAndUpdate(nextTurn, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: (_, session) =>
          Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)

      const activeFiber = yield* Effect.forkChild(
        session.submit("active").pipe(Effect.andThen(Deferred.succeed(activeSubmitted, undefined))),
      )
      yield* Deferred.await(activeStarted)
      expect(yield* Deferred.isDone(activeSubmitted)).toBe(true)
      const pending = yield* Effect.forkChild(session.submit("pending"))
      const removed = yield* Effect.forkChild(session.submit("removed"))
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow
      yield* session.submit("overflow")
      yield* Effect.yieldNow

      expect(yield* turns.readQueue(Thread.ThreadId.make("thread"))).toMatchObject({
        queuedCount: 2,
        turns: [
          { id: "turn-1", prompt: "pending", status: "queued" },
          { id: "turn-2", prompt: "removed", status: "queued" },
        ],
      })
      expect(events).toContainEqual(
        expect.objectContaining({
          _tag: "QueueUpdated",
          change: { _tag: "Added", item: { id: "turn-1", prompt: "pending" } },
        }),
      )
      expect(events).toContainEqual({
        _tag: "QueueFull",
        selectionEpoch: 0,
        threadId: "thread",
        capacity: 2,
        count: 2,
      })
      expect(yield* turns.get(Turn.TurnId.make("turn-3"))).toBeUndefined()
      yield* session.editQueued("turn-1", "edited")
      yield* session.dequeue("turn-2")
      expect(yield* turns.readQueue(Thread.ThreadId.make("thread"))).toMatchObject({
        queuedCount: 1,
        turns: [{ id: "turn-1", prompt: "edited", status: "queued" }],
      })
      expect(yield* Deferred.isDone(pendingStarted)).toBe(false)

      yield* Deferred.succeed(releaseActive, undefined)
      yield* Deferred.await(pendingStarted)
      yield* Effect.yieldNow
      yield* Fiber.join(activeFiber)
      yield* Fiber.join(pending)
      yield* Fiber.join(removed)
      expect(yield* turns.get(Turn.TurnId.make("turn-1"))).toMatchObject({ status: "completed" })
      expect(events.filter((event) => event._tag === "TurnStarted").map((event) => event.turn.id)).toEqual([
        "turn-0",
        "turn-1",
      ])
    }),
  )

  it.effect("edits and dequeues queued turns and reports the remaining queue", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* createTurn(turns, { id: Turn.TurnId.make("queued"), threadId: older.id, prompt: "before", now: 2 })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 2)
      yield* session.editQueued("queued", "after")
      yield* Effect.yieldNow
      expect((yield* turns.get(Turn.TurnId.make("queued")))?.prompt).toBe("after")
      expect(events.at(-1)).toEqual({
        _tag: "QueueUpdated",
        selectionEpoch: 2,
        threadId: "older",
        revision: 2,
        queuedCount: 1,
        change: { _tag: "Updated", item: { id: "queued", prompt: "after" } },
      })
      events.length = 0
      yield* session.selectThread(older.id, 3)
      yield* Effect.yieldNow
      const page = events.find((event) => event._tag === "SelectionLoaded")
      expect(page?._tag === "SelectionLoaded" ? page.entries.some((entry) => entry.turn.id === "queued") : true).toBe(
        false,
      )
      yield* session.dequeue("queued")
      yield* Effect.yieldNow
      expect(yield* turns.get(Turn.TurnId.make("queued"))).toBeUndefined()
      expect(events.at(-1)).toEqual({
        _tag: "QueueUpdated",
        selectionEpoch: 3,
        threadId: "older",
        revision: 3,
        queuedCount: 0,
        change: { _tag: "Removed", turnId: "queued" },
      })
    }),
  )

  it.effect("steers and cancels the selected active turn", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.steer("change course")
      yield* session.cancel
      yield* Effect.yieldNow
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["replay", "active", undefined],
        ["replay", "child:active:title", undefined],
        ["steer", "active", "change course", 0],
        ["cancel", "active", 0],
      ])
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancel-cursor",
      })
      expect(events.at(-1)).toEqual({
        _tag: "ExecutionControlled",
        selectionEpoch: 1,
        threadId: "older",
        turnId: "active",
        action: "cancelled",
        agentResponseArrived: false,
      })
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
        inspect: (turnId) =>
          turns.get(Turn.TurnId.make(turnId)).pipe(
            Effect.orDie,
            Effect.map((turn) =>
              turn === undefined
                ? undefined
                : { turnId, status: turn.status, waits: [], pendingTools: [], children: [] },
            ),
          ),
        steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
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
        interactive: (_, value) =>
          Ref.update(sessions, (values) => [...values, value]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const checkingSession = (yield* Ref.get(sessions))[0]
      if (checkingSession === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(checkingSession, events)
      yield* checkingSession.selectThread(older.id, 1)
      yield* checkingSession.interruptAndSend("next prompt")
      yield* Effect.yieldNow
      expect(yield* Ref.get(persistedAtCancel)).toMatchObject({ prompt: "next prompt", status: "queued" })
      expect((yield* turns.get(Turn.TurnId.make("active")))?.status).toBe("cancelled")
      expect(yield* turns.get(Turn.TurnId.make("pending"))).toMatchObject({
        status: "completed",
        lastCursor: "replacement-done",
      })
      expect(events.filter((event) => event._tag === "QueueUpdated").map((event) => event.change._tag)).toEqual([
        "Added",
        "Removed",
      ])
      expect(yield* Ref.get(controls)).toEqual([])
    }),
  )

  it.effect("maps allow, deny, and always permission decisions", () =>
    Effect.gen(function* () {
      const { session, controls } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("older", 1)
      yield* Ref.set(controls, [])
      events.length = 0
      yield* session.resolvePermission("allow-wait", "permission", "allow")
      yield* session.resolvePermission("deny-wait", "permission", "deny")
      yield* session.resolvePermission("always-wait", "permission", "always")
      yield* Effect.yieldNow
      expect((yield* Ref.get(controls)).filter(([operation]) => operation !== "replay")).toEqual([
        ["permission", "allow-wait", "Approved", 0],
        ["permission", "deny-wait", "Denied", 0],
        ["permission", "always-wait", "Always", 0],
      ])
      const resolved = events.filter((event) => event._tag === "ExecutionControlled")
      expect(resolved).toHaveLength(3)
      expect(resolved.every((event) => event.action === "permission-resolved" && event.selectionEpoch === 1)).toBe(true)
    }),
  )

  it.effect("resolves pending tool approvals through the tool approval endpoint", () =>
    Effect.gen(function* () {
      const { session, controls } = yield* makeHarness(false, ["allow-tool", "always-tool", "deny-tool"])
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("older", 1)
      yield* Ref.set(controls, [])
      yield* session.resolvePermission("allow-tool", "tool-approval", "allow")
      yield* session.resolvePermission("always-tool", "tool-approval", "always")
      yield* session.resolvePermission("deny-tool", "tool-approval", "deny")
      expect((yield* Ref.get(controls)).filter(([operation]) => operation !== "replay")).toEqual([
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
      yield* createTurn(turns, {
        id: Turn.TurnId.make("queued-after-wait"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 3,
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.resolvePermission("permission-wait", "permission", "allow")
      yield* Effect.yieldNow
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
        selectionEpoch: 1,
        threadId: "older",
        turnId: "active",
        revision: expect.any(Number),
        event: expect.objectContaining({ type: "model.output.completed", text: "created file" }),
      })
      expect(events).toContainEqual({
        _tag: "TranscriptPatched",
        selectionEpoch: 1,
        threadId: "older",
        turnId: "active",
        revision: expect.any(Number),
        event: expect.objectContaining({ cursor: "resumed-done", type: "execution.completed" }),
      })
      events.length = 0
      yield* session.selectThread(older.id, 2)
      yield* Effect.yieldNow
      const page = events.find((event) => event._tag === "SelectionLoaded")
      expect(page?._tag === "SelectionLoaded" ? page.entries : []).toEqual(
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

  it.effect("starts every queued turn exactly once after a waiting turn completes", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness(true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* turns.setStatus(Turn.TurnId.make("active"), "waiting", "wait-cursor", 2)
      for (const [index, id] of ["promoted-one", "promoted-two", "promoted-three"].entries())
        yield* createTurn(turns, {
          id: Turn.TurnId.make(id),
          threadId: older.id,
          prompt: id,
          now: 10 + index,
        })
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.resolvePermission("permission-wait", "permission", "allow")
      while (
        (yield* turns.get(Turn.TurnId.make("promoted-three")))?.status !== "completed" ||
        events.filter((event) => event._tag === "TurnStarted").length < 3
      )
        yield* Effect.yieldNow
      const calls = yield* Ref.get(controls)
      expect(calls.filter((call) => call[0] === "start")).toEqual([
        ["start", "promoted-one"],
        ["start", "promoted-two"],
        ["start", "promoted-three"],
      ])
      expect(calls.some((call) => call[0] === "follow" && String(call[1]).startsWith("promoted-"))).toBe(false)
      expect(
        events
          .filter((event) => event._tag === "TurnStarted")
          .map((event) => (event._tag === "TurnStarted" ? String(event.turn.id) : "")),
      ).toEqual(["promoted-one", "promoted-two", "promoted-three"])
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
          interactive: (_, session) =>
            Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
        })
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false, workspace: "/client-shell" }),
        )
        yield* waitForSessions(sessions)
        expect(yield* Ref.get(permissionWorkspaces)).toContain("/client-shell")
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("Missing interactive session")
        const allEvents: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(session, allEvents)

        const runShell = Effect.fn("InteractiveSessionTest.runShell")(function* (
          command: string,
          incognito: boolean,
          decision: "allow" | "deny" | "always",
        ) {
          const first = allEvents.length
          const fiber = yield* Effect.forkChild(session.shell(command, incognito))
          while (!allEvents.slice(first).some((event) => event._tag === "ShellPermissionRequested"))
            yield* Effect.yieldNow
          const permission = allEvents.slice(first).find((event) => event._tag === "ShellPermissionRequested")
          if (permission?._tag !== "ShellPermissionRequested") return yield* Effect.die("Missing shell permission")
          yield* session.resolvePermission(permission.id, "permission", decision)
          yield* Fiber.join(fiber)
          yield* Effect.yieldNow
          return allEvents.slice(first)
        })

        const persisted = yield* runShell("printf persisted", false, "allow")
        expect(persisted.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: false })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread")))[0]).toMatchObject({
          prompt: expect.stringContaining("output:-lc printf persisted"),
          status: "completed",
        })

        const denied = yield* runShell("printf denied", false, "deny")
        expect(denied.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
          message: "Shell command denied",
        })
        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted"])

        const beforeIncognito = (yield* turns.list(Thread.ThreadId.make("shell-thread"))).length
        const incognito = yield* runShell("printf secret", true, "always")
        expect(incognito.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: true })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread"))).length).toBe(beforeIncognito)
        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted", "-lc printf secret"])

        yield* turns.copy(
          {
            ...active(Thread.ThreadId.make("shell-thread"), "active-shell-blocker"),
            prompt: "active",
            createdAt: 2,
            updatedAt: 2,
          },
          128,
        )
        const queuedStart = allEvents.length
        yield* session.shell("printf queued", false)
        while (!allEvents.slice(queuedStart).some((event) => event._tag === "QueueUpdated")) yield* Effect.yieldNow
        const queued = allEvents.slice(queuedStart)
        expect(queued.some((event) => event._tag === "ShellPermissionRequested")).toBe(false)
        expect(queued.findLast((event) => event._tag === "QueueUpdated")).toMatchObject({
          change: { _tag: "Added", item: { prompt: expect.stringContaining("printf queued") } },
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
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.reopenThread(2)
      yield* session.replay("latest-active", "cursor-7")
      while (!events.some((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2))
        yield* Effect.yieldNow
      expect(events.find((event) => event._tag === "SelectionLoaded" && event.thread.id === "older")).toMatchObject({
        _tag: "SelectionLoaded",
        thread: { id: "older" },
        entries: [{ turn: { id: "active" } }],
      })
      expect(events.find((event) => event._tag === "SelectionLoaded" && event.thread.id === "latest")).toMatchObject({
        _tag: "SelectionLoaded",
        thread: { id: "latest" },
        entries: [{ turn: { id: "latest-active" } }],
      })
      expect(events.filter((event) => event._tag === "TranscriptPatched")).toEqual([])
      expect(events.find((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2)).toEqual({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 2,
        threadId: "latest",
        cost: { _tag: "Unavailable" },
        tokens: { _tag: "Unavailable" },
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["replay", "active", undefined],
        ["replay", "child:active:title", undefined],
        ["replay", "latest-active", undefined],
        ["replay", "latest-active", undefined],
        ["replay", "child:latest-active:title", undefined],
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
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const received = events.find((event) => event._tag === "SelectionLoaded")
      const projected =
        received?._tag === "SelectionLoaded" ? received.entries.filter((entry) => entry.turn.id === "active") : []
      expect(projected).toHaveLength(2)
      expect(projected.at(-1)?.unit).toMatchObject({
        revision: 450,
        content: { _tag: "Entry", role: "assistant", text: "event 450" },
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
        ["page", "active", "forward", "cursor-400", 200],
        ["replay", "active", undefined],
        ["replay", "child:active:title", undefined],
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
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
        message: expect.stringContaining("cursor did not advance"),
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
      ])
    }),
  )

  it.effect("keeps queued turns in the queue and out of the transcript when selecting a thread", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const queued = yield* createTurn(turns, {
        id: Turn.TurnId.make("queued-selection"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 2,
      })
      const shell = yield* turns.copy(
        {
          id: Turn.TurnId.make("recorded-shell"),
          threadId: older.id,
          prompt: "$ printf recorded\n\noutput:recorded",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 3,
          updatedAt: 4,
        },
        128,
      )
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 5)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "SelectionLoaded")).toMatchObject({
        queue: [{ id: queued.id }],
        entries: [
          { turn: { id: "active" }, unit: { content: { _tag: "Entry" } } },
          { turn: { id: shell.id, status: "completed" }, unit: { content: { _tag: "Entry" } } },
        ],
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["replay", "active", undefined],
        ["replay", "child:active:title", undefined],
      ])
    }),
  )

  it.effect("loads at least two hundred units to a Turn boundary and prepends older pages on demand", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      for (let index = 0; index < 240; index += 1) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(`history-${index.toString().padStart(3, "0")}`),
          threadId: older.id,
          prompt: `history ${index}`,
          now: index + 10,
        })
        yield* turns.setStatus(created.id, "completed", undefined, index + 10)
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow
      const initial = events.find((event) => event._tag === "SelectionLoaded")
      yield* session.loadOlder
      yield* Effect.yieldNow
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)
      expect(initial?._tag === "SelectionLoaded" ? initial.entries : []).toHaveLength(200)
      expect(initial?._tag === "SelectionLoaded" ? initial.entries[0]?.unit.key : undefined).toBe(
        "turn:history-040:user",
      )
      expect(
        initial?._tag === "SelectionLoaded" ? initial.entries.map((entry) => entry.turn.id).at(-1) : undefined,
      ).toBe(Turn.TurnId.make("history-239"))
      const prepended = events.find((event) => event._tag === "TranscriptPagePrepended")
      expect(prepended?._tag === "TranscriptPagePrepended" ? prepended.hasOlder : true).toBe(false)
      expect(
        prepended?._tag === "TranscriptPagePrepended" ? prepended.entries.map((entry) => entry.turn.id) : [],
      ).toEqual([
        Turn.TurnId.make("active"),
        ...Array.from({ length: 40 }, (_, index) => Turn.TurnId.make(`history-${index.toString().padStart(3, "0")}`)),
      ])
    }),
  )

  it.effect("stops the initial semantic page at the nearest Turn boundary", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(`boundary-${turnIndex}`),
          threadId: older.id,
          prompt: `boundary ${turnIndex}`,
          now: turnIndex + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, turnIndex + 10)
        const units: Array<Transcript.Unit> = [
          {
            key: `turn:${created.id}:user`,
            turnId: created.id,
            order: { sequence: 0, part: 0 },
            revision: 0,
            content: { _tag: "Entry", role: "user", text: created.prompt },
          },
          ...Array.from(
            { length: 72 },
            (_, index): Transcript.Unit => ({
              key: `${created.id}:assistant:${index.toString().padStart(2, "0")}`,
              turnId: created.id,
              order: { sequence: index + 1, part: 0 },
              revision: index + 1,
              content: { _tag: "Entry", role: "assistant", text: `${created.id} ${index}` },
            }),
          ),
        ]
        yield* transcripts.replace(completed, { ...Transcript.empty(created.id, created.prompt), units, revision: 72 })
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const initial = events.find((event) => event._tag === "SelectionLoaded")
      const loaded = initial?._tag === "SelectionLoaded" ? initial.entries : []
      expect(loaded).toHaveLength(219)
      expect(loaded[0]?.unit.key).toBe("turn:boundary-2:user")
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)

      yield* session.loadOlder
      yield* Effect.yieldNow
      const prepended = events.find((event) => event._tag === "TranscriptPagePrepended")
      const olderEntries = prepended?._tag === "TranscriptPagePrepended" ? prepended.entries : []
      expect(olderEntries).toHaveLength(50)
      expect(olderEntries.at(-1)?.unit.key).not.toBe(loaded[0]?.unit.key)
      expect(new Set([...olderEntries, ...loaded].map((entry) => entry.unit.key)).size).toBe(
        olderEntries.length + loaded.length,
      )
    }),
  )

  it.effect("projects control failures instead of failing the session effect", () =>
    Effect.gen(function* () {
      const { session } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("missing", 1)
      yield* session.steer("nowhere")
      yield* session.editQueued("missing", "no")
      yield* Effect.yieldNow
      const failures = events.filter((event) => event._tag === "ExecutionFailed")
      expect(failures).toHaveLength(3)
      expect(failures[0]).toMatchObject({ message: expect.stringContaining("Thread missing does not exist") })
      expect(failures[1]).toMatchObject({ message: expect.stringContaining("No thread selected") })
      expect(failures[2]).toMatchObject({ message: expect.stringContaining("is not queued") })
    }),
  )
})

const subagentToolId = "done:call_1"
const subagentChildId = "child:execution%3Adone:call_1"

const subagentRootEvents: ReadonlyArray<ExecutionBackend.Event> = [
  {
    cursor: "done-call",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 1,
    data: { tool_call_id: "call_1", tool_name: "oracle", input: { prompt: "Review the plan." } },
  },
  {
    cursor: `execution:done:child:${subagentChildId}`,
    sequence: 2,
    type: "child_run.spawned",
    createdAt: 2,
    data: { child_execution_id: subagentChildId, preset_name: "Oracle" },
  },
  {
    cursor: `execution:done:child:${subagentChildId}:completed`,
    sequence: 3,
    type: "child_run.event",
    createdAt: 3,
    data: { child_execution_id: subagentChildId, status: "completed" },
  },
  {
    cursor: "done-result",
    sequence: 4,
    type: "tool.result.received",
    createdAt: 4,
    data: { tool_call_id: "call_1", output: { output: [{ type: "text", text: "**All tests pass.**" }] } },
  },
  { cursor: "done-final", sequence: 5, type: "execution.completed", createdAt: 5 },
]

const subagentChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
  {
    cursor: `${subagentChildId}:tool`,
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 1,
    data: { tool_call_id: "child-call", tool_name: "bash", input: { command: "bun test" } },
  },
  {
    cursor: `${subagentChildId}:result`,
    sequence: 2,
    type: "tool.result.received",
    createdAt: 2,
    data: { tool_call_id: "child-call", output: { text: "ok" } },
  },
  {
    cursor: `${subagentChildId}:answer`,
    sequence: 3,
    type: "model.output.completed",
    createdAt: 3,
    text: "**All tests pass.**",
  },
  { cursor: `${subagentChildId}:completed`, sequence: 4, type: "execution.completed", createdAt: 4 },
]

const makeSubagentReloadHarness = Effect.fn("InteractiveSessionTest.makeSubagentReloadHarness")(function* (options: {
  readonly storedTree: Transcript.Projection
  readonly turnLastCursor: string
  readonly childReplayEvents: ReadonlyArray<ExecutionBackend.Event>
}) {
  const subagentThread = thread("subagent-thread", 1)
  const doneTurn: Turn.Turn = {
    id: Turn.TurnId.make("done"),
    threadId: subagentThread.id,
    prompt: "delegate",
    executionRoute: executionRoute(),
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    lastCursor: options.turnLastCursor,
  }
  const repositories = yield* ThreadRepository.makeMemory([subagentThread])
  const turns = yield* TurnRepository.makeMemory([doneTurn])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const transcripts = Context.get(yield* Layer.build(TranscriptRepository.memoryLayer), TranscriptRepository.Service)
  yield* transcripts.replace(doneTurn, options.storedTree)
  const inspection = (turnId: string): ExecutionBackend.Inspection =>
    turnId === "done"
      ? {
          turnId,
          status: "completed",
          lastCursor: "done-final",
          waits: [],
          pendingTools: [],
          children: [{ executionId: subagentChildId, status: "completed" }],
        }
      : { turnId, status: "completed", waits: [], pendingTools: [], children: [] }
  const eventsFor = (turnId: string): ReadonlyArray<ExecutionBackend.Event> =>
    turnId === subagentChildId ? options.childReplayEvents : []
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
    inspect: (turnId) => Effect.succeed(inspection(turnId)),
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    replay: (turnId) => Effect.succeed({ turnId, status: "completed" as const, events: eventsFor(turnId) }),
    pageEvents: (turnId, _direction, cursor) => {
      const events = eventsFor(turnId)
      const boundary = cursor === undefined ? -1 : events.findIndex((event) => event.cursor === cursor)
      return Effect.succeed({
        events: events.slice(boundary + 1),
        hasMore: false,
        ...(events.at(-1) === undefined ? {} : { newestCursor: events.at(-1)!.cursor }),
      })
    },
    listApprovals: () => Effect.succeed([]),
    resolveToolApproval: () => Effect.void,
    resolvePermission: () => Effect.void,
  })
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.die("unused"),
    interactive: (_, session) =>
      Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
  })
  const context = yield* Layer.build(layer)
  const operation = Context.get(context, Operation.Service)
  yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
  yield* waitForSessions(sessions)
  const session = (yield* Ref.get(sessions))[0]
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return { session, subagentThread, transcripts }
})

const selectionEntriesFor = (
  session: Operation.InteractiveSession,
  threadId: Thread.ThreadId,
): Effect.Effect<
  {
    readonly entries: ReadonlyArray<TranscriptRepository.Entry>
    readonly events: ReadonlyArray<Operation.InteractiveEvent>
  },
  Operation.OperationUnavailable
> =>
  Effect.gen(function* () {
    const events: Array<Operation.InteractiveEvent> = []
    yield* collectEvents(session, events)
    yield* session.selectThread(threadId, 1)
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const loaded = events.find((event) => event._tag === "TranscriptReplaced")
      if (loaded !== undefined) return { entries: loaded._tag === "TranscriptReplaced" ? loaded.entries : [], events }
      yield* Effect.yieldNow
    }
    return { entries: [], events }
  })

const nestedSubagentExpectations = (entries: ReadonlyArray<TranscriptRepository.Entry>) => {
  const nested = entries.filter((entry) => entry.unit.parentId === subagentToolId)
  const nestedTool = nested.some(
    (entry) =>
      entry.unit.content._tag === "Block" &&
      entry.unit.content.block._tag === "ToolCall" &&
      entry.unit.content.block.name === "bash",
  )
  const nestedAnswer = nested.some(
    (entry) =>
      entry.unit.content._tag === "Entry" &&
      entry.unit.content.role === "assistant" &&
      entry.unit.content.text.includes("All tests pass."),
  )
  return { nestedTool, nestedAnswer }
}

describe("InteractiveSession subagent reload", () => {
  it.effect("repairs a persisted subagent tree whose child transcript is empty", () =>
    Effect.gen(function* () {
      const rootProjection = Transcript.project("done", "delegate", subagentRootEvents)
      const brokenTree = Transcript.withNestedProjections(rootProjection, [
        { parentId: subagentToolId, projection: Transcript.empty(subagentChildId, "") },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree: { ...brokenTree, pricingVersion: Transcript.pricingVersion },
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
      })
      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id)
      expect(events.findIndex((event) => event._tag === "SelectionLoaded")).toBeLessThan(
        events.findIndex((event) => event._tag === "TranscriptReplaced"),
      )
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
    }),
  )

  it.effect("keeps persisted subagent transcripts when the backend can no longer replay the child", () =>
    Effect.gen(function* () {
      const rootProjection = Transcript.project("done", "delegate", subagentRootEvents)
      const linkedRoot: Transcript.Projection = {
        ...rootProjection,
        units: rootProjection.units.flatMap((unit) => {
          if (unit.content._tag !== "Block") return [unit]
          if (unit.content.block._tag === "ChildAgent") return []
          if (unit.content.block._tag === "ToolCall" && unit.content.block.id === subagentToolId)
            return [
              {
                ...unit,
                content: {
                  _tag: "Block" as const,
                  block: { ...unit.content.block, childId: subagentChildId, status: "complete" as const },
                },
              },
            ]
          return [unit]
        }),
      }
      const childProjection = Transcript.project(subagentChildId, "", subagentChildEvents)
      const richTree = Transcript.withNestedProjections(linkedRoot, [
        { parentId: subagentToolId, projection: childProjection },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree: { ...richTree, pricingVersion: Transcript.pricingVersion },
        turnLastCursor: "done-later",
        childReplayEvents: [],
      })
      const { entries } = yield* selectionEntriesFor(session, subagentThread.id)
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
    }),
  )
})
