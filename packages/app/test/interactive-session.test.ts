import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as UsageRepository from "@rika/persistence/usage-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as ExecutionIngest from "../src/execution-ingest"
import { Operation } from "../src/index"
import * as UsageCost from "../src/usage-cost"
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
  lineage: { _tag: "Original" },
  createdAt: updatedAt,
  updatedAt,
})

const active = (threadId: Thread.ThreadId, id = "active"): Turn.Turn => ({
  id: Turn.TurnId.make(id),
  threadId,
  prompt: "active prompt",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: executionRoute(),
  status: "running",
  stopIntent: "none",
  createdAt: 1,
  updatedAt: 1,
  lastCursor: "active-cursor",
})

const makeHarness = Effect.fn("InteractiveSessionTest.makeHarness")(function* (
  followAfterPermission: boolean = false,
  toolApprovalWaitIds: ReadonlyArray<string> = [],
  pagedEvents?: ReadonlyArray<ExecutionBackend.Event>,
  stalePageCursor: boolean = false,
  turnPageRequests?: Ref.Ref<ReadonlyArray<TurnRepository.PageCursor | undefined>>,
  cancelFailure: boolean = false,
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
              events: [
                {
                  executionId: `execution:${input.turnId}`,
                  cursor: "queued-done",
                  sequence: 1,
                  type: "execution.completed",
                  createdAt: 3,
                },
              ],
            }),
          )
        : Effect.die("unused"),
    ...(followAfterPermission
      ? {
          follow: (
            turnId: string,
            checkpoint: string | ExecutionBackend.ExecutionCheckpoint | undefined,
            onEvent?: (event: ExecutionBackend.Event) => void,
          ) => {
            const afterCursor = typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor
            const output = {
              executionId: `execution:${turnId}`,
              cursor: "resumed-output",
              sequence: 2,
              type: "model.output.completed",
              createdAt: 2,
              text: "created file",
            }
            const completed = {
              executionId: `execution:${turnId}`,
              cursor: "resumed-done",
              sequence: 3,
              type: "execution.completed",
              createdAt: 3,
            }
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
        Effect.andThen(
          cancelFailure
            ? Effect.fail(ExecutionBackend.BackendError.make({ message: "cancel unavailable" }))
            : Effect.void,
        ),
        Effect.as({
          turnId,
          status: "cancelled" as const,
          events: [
            {
              executionId: `execution:${turnId}`,
              cursor: "cancel-cursor",
              sequence: 1,
              type: "execution.cancelled",
              createdAt: now,
            },
          ],
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
    resolveInvocationSource: () => Effect.die("unused"),
  })
  const selectionTurns: TurnRepository.Interface =
    turnPageRequests === undefined
      ? turns
      : {
          ...turns,
          page: (threadId, options) =>
            Ref.update(turnPageRequests, (requests) => [...requests, options?.before]).pipe(
              Effect.andThen(turns.page(threadId, options)),
            ),
        }
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, selectionTurns),
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
        resolveInvocationSource: () => Effect.die("unused"),
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
      yield* alpha.submit("alpha prompt")
      yield* beta.submit("beta prompt")
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
              {
                executionId: `execution:${input.turnId}`,
                cursor: "output",
                sequence: 1,
                type: "model.output.completed",
                createdAt: 1,
              },
              {
                executionId: `execution:${input.turnId}`,
                cursor: "done",
                sequence: 2,
                type: "execution.completed",
                createdAt: 2,
              },
            ],
          }),
        replay: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.die("unused"),
        resolveInvocationSource: () => Effect.die("unused"),
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
      while (events.filter((event) => event._tag !== "ThreadsListed").length < 6) yield* Effect.yieldNow
      expect(events.filter((event) => event._tag !== "ThreadsListed")).toEqual([
        { _tag: "ThreadActivated", threadId: "created", title: "New thread" },
        {
          _tag: "ThreadUsageUpdated",
          selectionEpoch: 0,
          threadId: "created",
          revision: 0,
          cost: { _tag: "Unavailable" },
          tokens: { _tag: "Unavailable" },
          time: { _tag: "Unavailable" },
        },
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
          event: {
            executionId: "execution:created-turn",
            cursor: "output",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 1,
          },
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "created",
          turnId: "created-turn",
          revision: 2,
          event: {
            executionId: "execution:created-turn",
            cursor: "done",
            sequence: 2,
            type: "execution.completed",
            createdAt: 2,
          },
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
        resolveInvocationSource: () => Effect.die("unused"),
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
        ["steer", "active", "change course", "rika:interactive-steer:active:0"],
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
            events: [
              {
                executionId: `execution:${input.turnId}`,
                cursor: "replacement-done",
                sequence: 1,
                type: "execution.completed",
                createdAt: 4,
              },
            ],
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
        resolveInvocationSource: () => Effect.die("unused"),
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
        executionId: "execution:active",
        cursor: "prior-output",
        sequence: 0,
        type: "model.output.completed",
        createdAt: 1,
        text: "work before permission",
      }
      const priorPermission = {
        executionId: "execution:active",
        cursor: "permission-wait",
        sequence: 1,
        type: "permission.ask.requested",
        createdAt: 1,
        data: { wait_id: "permission-wait", title: "Allow work" },
      }
      const { session, turns, older } = yield* makeHarness(true, [], [priorOutput, priorPermission])
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
              resolveInvocationSource: () => Effect.die("unused"),
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
      yield* awaitSelectionEntries(events, (entries) => entries.some((entry) => entry.turn.id === "latest-active"))
      expect(events.some((event) => event._tag === "SelectionLoaded" && event.thread.id === "older")).toBe(true)
      expect(latestSelectionEntries(events)?.map((entry) => entry.turn.id)).toEqual(["latest-active"])
      expect(events.filter((event) => event._tag === "TranscriptPatched")).toEqual([])
      expect(events.find((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2)).toEqual({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 2,
        threadId: "latest",
        revision: 0,
        cost: { _tag: "Unavailable" },
        tokens: { _tag: "Unavailable" },
        time: { _tag: "Unavailable" },
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
          executionId: "execution:active",
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

      const received = yield* awaitSelectionEntries(
        events,
        (entries) => entries.filter((entry) => entry.turn.id === "active").length >= 2,
      )
      const projected = received.filter((entry) => entry.turn.id === "active")
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

  it.effect("stops ingesting and reports a failure when forward paging stops advancing", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): ExecutionBackend.Event => ({
          executionId: "execution:active",
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
        threadId: older.id,
        turnId: Turn.TurnId.make("active"),
        message: expect.stringContaining("lost its place"),
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
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: executionRoute(),
          status: "completed",
          stopIntent: "none",
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

      expect(events.find((event) => event._tag === "SelectionLoaded")).toMatchObject({ queue: [{ id: queued.id }] })
      expect(yield* awaitSelectionEntries(events, (entries) => entries.length >= 2)).toMatchObject([
        { turn: { id: "active" }, unit: { content: { _tag: "Entry" } } },
        { turn: { id: shell.id, status: "completed" }, unit: { content: { _tag: "Entry" } } },
      ])
      expect(yield* Ref.get(controls)).toEqual([["replay", "active", undefined]])
    }),
  )

  it.effect("bounds the initial page and exhausts older pages without duplicate units", () =>
    Effect.gen(function* () {
      const turnPageRequests = yield* Ref.make<ReadonlyArray<TurnRepository.PageCursor | undefined>>([])
      const { session, turns, older } = yield* makeHarness(false, [], undefined, false, turnPageRequests)
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
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)
      if (initial?._tag !== "SelectionLoaded" || initial.oldestCursor === undefined)
        return yield* Effect.die("missing initial transcript cursor")
      const loaded = initial?._tag === "SelectionLoaded" ? [...initial.entries] : []
      expect(loaded.length).toBeGreaterThan(0)
      expect(loaded.length).toBeLessThanOrEqual(200)
      const turnPagesBeforeIdle = (yield* Ref.get(turnPageRequests)).length
      for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow
      expect(yield* Ref.get(turnPageRequests)).toHaveLength(turnPagesBeforeIdle)
      yield* session.loadOlder(
        "different-thread",
        1,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
      yield* session.loadOlder(
        older.id,
        2,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
      expect(yield* Ref.get(turnPageRequests)).toHaveLength(turnPagesBeforeIdle)
      let hasOlder = true
      let before = initial.oldestCursor
      for (let page = 0; page < 10 && hasOlder; page += 1) {
        const previous = events.filter((event) => event._tag === "TranscriptPagePrepended").length
        yield* session.loadOlder(
          older.id,
          1,
          before,
          loaded.map((entry) => entry.unit.key),
        )
        for (
          let attempt = 0;
          attempt < 400 && events.filter((event) => event._tag === "TranscriptPagePrepended").length === previous;
          attempt += 1
        )
          yield* Effect.yieldNow
        const prepended = events.findLast((event) => event._tag === "TranscriptPagePrepended")
        if (prepended?._tag !== "TranscriptPagePrepended") break
        loaded.unshift(...prepended.entries)
        hasOlder = prepended.hasOlder
        if (prepended.oldestCursor !== undefined) before = prepended.oldestCursor
      }
      let replacements = -1
      for (let idle = 0, attempt = 0; idle < 100 && attempt < 20000; attempt += 1) {
        const observed = events.filter((event) => event._tag === "TranscriptReplaced").length
        idle = observed === replacements ? idle + 1 : 0
        replacements = observed
        yield* Effect.yieldNow
      }
      const loadedKeys = new Set(loaded.map((entry) => entry.unit.key))
      for (const replacement of events) {
        if (replacement._tag !== "TranscriptReplaced") continue
        for (const entry of replacement.entries) {
          if (loadedKeys.has(entry.unit.key)) continue
          loadedKeys.add(entry.unit.key)
          loaded.push(entry)
        }
      }
      expect(hasOlder).toBe(false)
      expect(new Set(loaded.map((entry) => entry.unit.key)).size).toBe(loaded.length)
      expect(loaded.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === "turn:history-000:user")).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === "turn:history-239:user")).toBe(true)
      expect((yield* Ref.get(turnPageRequests)).length).toBeGreaterThan(turnPagesBeforeIdle)
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
              content: { _tag: "Entry", role: "assistant", text: `${created.id} ${index} ${"x".repeat(50_000)}` },
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
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(initial)
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(10 * 1024 * 1024)
      expect(loaded.length).toBeGreaterThan(0)
      expect(loaded[0]?.unit.key).toBe(`turn:${loaded[0]?.turn.id}:user`)
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)
      if (initial?._tag !== "SelectionLoaded" || initial.oldestCursor === undefined)
        return yield* Effect.die("missing initial transcript cursor")

      yield* session.loadOlder(
        older.id,
        1,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
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

  it.effect("keeps a prior conversation boundary when nested units crowd the newest Turn past the wire page", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      const created = yield* createTurn(turns, {
        id: Turn.TurnId.make("oversized"),
        threadId: older.id,
        prompt: "oversized prompt",
        now: 10,
      })
      const completed = yield* turns.setStatus(created.id, "completed", undefined, 10)
      const units: Array<Transcript.Unit> = [
        {
          key: `turn:${created.id}:user`,
          turnId: created.id,
          order: { sequence: 0, part: 0 },
          revision: 0,
          content: { _tag: "Entry", role: "user", text: created.prompt },
        },
        {
          key: `${created.id}:assistant:opening`,
          turnId: created.id,
          order: { sequence: 1, part: 0 },
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "opening response" },
        },
        {
          key: `compaction:${created.id}`,
          turnId: created.id,
          order: { sequence: 1, part: 1 },
          revision: 2,
          content: {
            _tag: "Block",
            block: {
              _tag: "Compaction",
              summary: "Earlier thread context was compacted.",
              status: "complete",
              checkpoint: "checkpoint-oversized",
            },
          },
        },
        ...Array.from(
          { length: 260 },
          (_, index): Transcript.Unit => ({
            key: `${created.id}:assistant:${index.toString().padStart(3, "0")}`,
            turnId: created.id,
            order: { sequence: index + 2, part: 0 },
            revision: index + 2,
            parentId: "nested-agent",
            content: {
              _tag: "Block",
              block: { _tag: "Notification", title: String(index), detail: "x".repeat(40_000) },
            },
          }),
        ),
        {
          key: `${created.id}:assistant:final`,
          turnId: created.id,
          order: { sequence: 262, part: 0 },
          revision: 262,
          content: { _tag: "Entry", role: "assistant", text: "final response" },
        },
      ]
      yield* transcripts.replace(completed, { ...Transcript.empty(created.id, created.prompt), units, revision: 262 })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const loaded = yield* awaitSelectionEntries(events, (entries) =>
        entries.some((entry) => entry.unit.key === "turn:active:user"),
      )
      const initial = events.find((event) => event._tag === "SelectionLoaded")
      const cursor = initial?._tag === "SelectionLoaded" ? initial.oldestCursor : undefined
      if (cursor === undefined) return yield* Effect.die("missing initial transcript cursor")
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(initial)
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(10 * 1024 * 1024)
      expect(loaded.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.filter((entry) => entry.unit.key === "turn:active:user")).toHaveLength(1)
      expect(loaded.some((entry) => entry.unit.key === `turn:${created.id}:user`)).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === `${created.id}:assistant:opening`)).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === `${created.id}:assistant:final`)).toBe(true)
      expect(loaded.filter((entry) => entry.unit.key === `compaction:${created.id}`)).toHaveLength(1)
      expect(cursor?.key).not.toBe(`turn:${created.id}:user`)

      const olderEntries: Array<TranscriptRepository.Entry> = []
      let hasOlder = initial?._tag === "SelectionLoaded" ? initial.hasOlder : false
      let before = cursor
      for (let page = 0; page < 20 && hasOlder; page += 1) {
        const previousPages = events.filter((event) => event._tag === "TranscriptPagePrepended").length
        yield* session.loadOlder(
          older.id,
          1,
          before,
          [...olderEntries, ...loaded].map((entry) => entry.unit.key),
        )
        for (
          let attempt = 0;
          attempt < 400 && events.filter((event) => event._tag === "TranscriptPagePrepended").length === previousPages;
          attempt += 1
        )
          yield* Effect.yieldNow
        const prepended = events.findLast((event) => event._tag === "TranscriptPagePrepended")
        if (prepended?._tag !== "TranscriptPagePrepended") break
        olderEntries.unshift(...prepended.entries)
        hasOlder = prepended.hasOlder
        if (prepended.oldestCursor !== undefined) before = prepended.oldestCursor
      }
      expect(olderEntries.length).toBeGreaterThan(0)
      const cursorEntry = loaded.find((entry) => entry.unit.key === cursor?.key)
      expect(olderEntries.at(-1)?.unit.order.sequence).toBeLessThan(cursorEntry!.unit.order.sequence)
      const allEntries = [...olderEntries, ...loaded]
      expect(new Set(allEntries.map((entry) => entry.unit.key)).size).toBe(allEntries.length)
      expect(allEntries.filter((entry) => entry.unit.parentId === "nested-agent")).toHaveLength(260)
      expect(hasOlder).toBe(false)
    }),
  )

  it.effect("keeps earlier conversation Turns when a cancelled Turn's child units outnumber the wire page", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      const conversation = [
        { id: "hey", prompt: "Hey", reply: "Hey! What can I help you with?", children: 0 },
        { id: "explore", prompt: "Explore this project", reply: "I’ll trace the current path flow.", children: 600 },
        { id: "followup", prompt: "Also note any tests that cover permissions.", reply: "Got it.", children: 0 },
        { id: "retry", prompt: "Explore this project", reply: "I’ll trace the permission enforcement.", children: 600 },
      ]
      for (const [index, entry] of conversation.entries()) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(entry.id),
          threadId: older.id,
          prompt: entry.prompt,
          now: index + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, index + 10)
        const units: Array<Transcript.Unit> = [
          {
            key: `turn:${created.id}:user`,
            turnId: created.id,
            order: { sequence: 0, part: 0 },
            revision: 0,
            content: { _tag: "Entry", role: "user", text: entry.prompt },
          },
          {
            key: `assistant:${created.id}:0`,
            turnId: created.id,
            order: { sequence: 1, part: 0 },
            revision: 1,
            content: { _tag: "Entry", role: "assistant", text: entry.reply },
          },
          ...Array.from(
            { length: entry.children },
            (_, child): Transcript.Unit => ({
              key: `${created.id}:child:${child.toString().padStart(3, "0")}`,
              turnId: `child:${created.id}`,
              parentId: `tool:${created.id}:delegate`,
              order: { sequence: child + 2, part: 0 },
              revision: child + 2,
              content: { _tag: "Block", block: { _tag: "Reasoning", text: `child ${child}` } },
            }),
          ),
        ]
        yield* transcripts.replace(completed, {
          ...Transcript.empty(created.id, created.prompt),
          units,
          revision: units.length,
        })
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const initial = events.find((event) => event._tag === "SelectionLoaded")
      const loaded = initial?._tag === "SelectionLoaded" ? initial.entries : []
      const keys = new Set(loaded.map((entry) => entry.unit.key))
      for (const entry of conversation) {
        expect(keys.has(`turn:${entry.id}:user`)).toBe(true)
        expect(keys.has(`assistant:${entry.id}:0`)).toBe(true)
      }
      const newest = loaded.filter((entry) => entry.turn.id === "retry")
      expect(newest.length).toBeLessThanOrEqual(400)
      expect(newest.filter((entry) => entry.unit.parentId !== undefined).length).toBeGreaterThan(0)
      expect(loaded.filter((entry) => entry.turn.id === "explore" && entry.unit.parentId !== undefined)).toHaveLength(0)
      expect(keys.size).toBe(loaded.length)
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)
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

  it.effect("keeps the active turn running when the cancellation request fails", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness(false, [], undefined, false, undefined, true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      events.length = 0
      yield* session.cancel
      yield* Effect.yieldNow
      expect(events).toContainEqual(expect.objectContaining({ _tag: "ExecutionControlFailed", action: "cancel" }))
      expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(yield* turns.findActive(older.id)).toMatchObject({ status: "running" })
    }),
  )
})

const subagentToolId = "done:call_1"
const subagentChildId = "child:execution%3Adone:call_1"

const subagentRootEvents: ReadonlyArray<ExecutionBackend.Event> = [
  {
    executionId: "execution:done",
    cursor: "done-call",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 1,
    data: { tool_call_id: "call_1", tool_name: "oracle", input: { prompt: "Review the plan." } },
  },
  {
    executionId: "execution:done",
    cursor: "done-spawn",
    sequence: 2,
    type: "child_run.spawned",
    createdAt: 2,
    data: { child_execution_id: subagentChildId, preset_name: "Oracle" },
  },
  {
    executionId: "execution:done",
    cursor: "done-child-completed",
    sequence: 3,
    type: "child_run.event",
    createdAt: 3,
    data: { child_execution_id: subagentChildId, status: "completed" },
  },
  {
    executionId: "execution:done",
    cursor: "done-result",
    sequence: 4,
    type: "tool.result.received",
    createdAt: 4,
    data: { tool_call_id: "call_1", output: { output: [{ type: "text", text: "**All tests pass.**" }] } },
  },
  { executionId: "execution:done", cursor: "done-final", sequence: 5, type: "execution.completed", createdAt: 5 },
]

const subagentChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
  {
    executionId: subagentChildId,
    cursor: "childtool~a1",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 1,
    data: { tool_call_id: "child-call", tool_name: "bash", input: { command: "bun test" } },
  },
  {
    executionId: subagentChildId,
    cursor: "childresult~a2",
    sequence: 2,
    type: "tool.result.received",
    createdAt: 2,
    data: { tool_call_id: "child-call", output: { text: "ok" } },
  },
  {
    executionId: subagentChildId,
    cursor: "childanswer~a3",
    sequence: 3,
    type: "model.output.completed",
    createdAt: 3,
    text: "**All tests pass.**",
  },
  { executionId: subagentChildId, cursor: "childdone~a4", sequence: 4, type: "execution.completed", createdAt: 4 },
]

const makeSubagentReloadHarness = Effect.fn("InteractiveSessionTest.makeSubagentReloadHarness")(function* (options: {
  readonly storedTree: Transcript.Projection
  readonly turnLastCursor: string
  readonly childReplayEvents: ReadonlyArray<ExecutionBackend.Event>
  readonly turnStatus?: Turn.Status
  readonly followed?: Ref.Ref<ReadonlyArray<string>>
  readonly inspection?: (executionId: string) => ExecutionBackend.Inspection | undefined
  readonly replayEvents?: (executionId: string) => ReadonlyArray<ExecutionBackend.Event>
  readonly pageEvents?: (executionId: string, after: string | undefined) => ExecutionBackend.EventPage
}) {
  const subagentThread = thread("subagent-thread", 1)
  const doneTurn: Turn.Turn = {
    id: Turn.TurnId.make("done"),
    threadId: subagentThread.id,
    prompt: "delegate",
    stopIntent: "none",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    executionRoute: executionRoute(),
    status: options.turnStatus ?? "completed",
    createdAt: 1,
    updatedAt: 1,
    lastCursor: options.turnLastCursor,
  }
  const repositories = yield* ThreadRepository.makeMemory([subagentThread])
  const turns = yield* TurnRepository.makeMemory([doneTurn])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const transcripts = Context.get(yield* Layer.build(TranscriptRepository.memoryLayer), TranscriptRepository.Service)
  yield* transcripts.replace(doneTurn, options.storedTree)
  const inspection = (turnId: string): ExecutionBackend.Inspection | undefined => {
    if (options.inspection !== undefined) return options.inspection(turnId)
    if (turnId !== "done") return { turnId, status: "completed", waits: [], pendingTools: [], children: [] }
    return {
      turnId,
      status: options.turnStatus ?? "completed",
      lastCursor: "done-final",
      waits: [],
      pendingTools: [],
      children: [{ executionId: subagentChildId, status: "completed" }],
    }
  }
  const eventsFor = (turnId: string): ReadonlyArray<ExecutionBackend.Event> =>
    options.replayEvents?.(turnId) ?? (turnId === subagentChildId ? options.childReplayEvents : [])
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
    follow: (turnId, cursor, onEvent) => {
      const after = typeof cursor === "string" ? cursor : cursor?.cursor
      const all = eventsFor(turnId)
      const boundary = after === undefined ? -1 : all.findIndex((event) => event.cursor === after)
      const events = all.slice(boundary + 1)
      const inspected = inspection(turnId)
      return (
        options.followed === undefined ? Effect.void : Ref.update(options.followed, (followed) => [...followed, turnId])
      ).pipe(
        Effect.andThen(
          inspected === undefined
            ? ExecutionBackend.BackendError.make({ message: `ExecutionNotFound ${turnId}` })
            : Effect.void,
        ),
        Effect.tap(() => Effect.sync(() => events.forEach((event) => onEvent?.(event)))),
        Effect.as({ turnId, status: inspected?.status ?? ("completed" as const), events }),
      )
    },
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    replay: (turnId) => Effect.succeed({ turnId, status: "completed" as const, events: eventsFor(turnId) }),
    pageEvents: (turnId, _direction, cursor) =>
      Effect.sync(() => {
        if (options.pageEvents !== undefined) return options.pageEvents(turnId, cursor)
        const events = eventsFor(turnId)
        const boundary = cursor === undefined ? -1 : events.findIndex((event) => event.cursor === cursor)
        return {
          events: events.slice(boundary + 1),
          hasMore: false,
          ...(events.at(-1) === undefined ? {} : { newestCursor: events.at(-1)!.cursor }),
        }
      }),
    listApprovals: () => Effect.succeed([]),
    resolveToolApproval: () => Effect.void,
    resolvePermission: () => Effect.void,
    resolveInvocationSource: () => Effect.die("unused"),
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
  return { session, subagentThread, transcripts, turns }
})

const latestSelectionEntries = (events: ReadonlyArray<Operation.InteractiveEvent>) => {
  let entries: ReadonlyArray<TranscriptRepository.Entry> | undefined
  for (const event of events) {
    if (event._tag === "SelectionLoaded") entries = event.entries
    else if (event._tag === "TranscriptReplaced") {
      const replaced = new Set(event.entries.map((entry) => entry.turn.id))
      entries = [...(entries ?? []).filter((entry) => !replaced.has(entry.turn.id)), ...event.entries].toSorted(
        (left, right) =>
          left.turn.createdAt - right.turn.createdAt ||
          left.unit.order.sequence - right.unit.order.sequence ||
          left.unit.order.part - right.unit.order.part,
      )
    }
  }
  return entries
}

const awaitSelectionEntries = (
  events: ReadonlyArray<Operation.InteractiveEvent>,
  until: (entries: ReadonlyArray<TranscriptRepository.Entry>) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const entries = latestSelectionEntries(events)
      if (entries !== undefined && until(entries)) return entries
      yield* Effect.yieldNow
    }
    return latestSelectionEntries(events) ?? []
  })

const selectionEntriesFor = (
  session: Operation.InteractiveSession,
  threadId: Thread.ThreadId,
  until?: (entries: ReadonlyArray<TranscriptRepository.Entry>) => boolean,
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
    const entries = yield* awaitSelectionEntries(events, (loaded) => until === undefined || until(loaded))
    return { entries, events }
  })

const nestedSubagentReady = (entries: ReadonlyArray<TranscriptRepository.Entry>) => {
  const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
  return nestedTool && nestedAnswer
}

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
  it.effect("corrects terminal child outcomes in an already-failed checkpoint", () =>
    Effect.gen(function* () {
      const failedRoot = Transcript.project("done", "delegate", [
        ...subagentRootEvents.slice(0, 2),
        {
          executionId: "execution:done",
          cursor: "failed-root",
          sequence: 3,
          type: "execution.failed",
          createdAt: 5,
          text: "root failed after delegation",
        },
      ])
      const completedChild = Transcript.project(subagentChildId, "", subagentChildEvents)
      const storedTree = Transcript.withNestedProjections(failedRoot, [
        { parentId: subagentToolId, projection: completedChild },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "failed-root",
        childReplayEvents: subagentChildEvents,
        turnStatus: "failed",
      })

      const reconciledParent = (entries: ReadonlyArray<TranscriptRepository.Entry>) =>
        entries.find(
          (entry) =>
            entry.unit.parentId === undefined &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.id === subagentToolId,
        )
      const { entries } = yield* selectionEntriesFor(session, subagentThread.id, (loaded) => {
        const content = reconciledParent(loaded)?.unit.content
        return content?._tag === "Block" && content.block._tag === "ToolCall" && content.block.status === "complete"
      })
      const parent = reconciledParent(entries)
      expect(parent?.unit.content).toMatchObject({
        _tag: "Block",
        block: { _tag: "ToolCall", status: "complete" },
      })
      expect(
        entries.some(
          (entry) =>
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "Error" &&
            entry.unit.content.block.detail === "root failed after delegation",
        ),
      ).toBe(true)
    }),
  )

  it.effect("rebuilds a failed root and terminal descendant tree in a replacement session", () =>
    Effect.gen(function* () {
      const completedChildId = "child:execution%3Adone:completed"
      const failedChildId = "child:execution%3Adone:failed"
      const nestedChildId = `child:${encodeURIComponent(completedChildId)}:nested`
      const rootEvents: ReadonlyArray<ExecutionBackend.Event> = [
        {
          executionId: "execution:done",
          cursor: "root-completed-tool",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "completed", tool_name: "task", input: { prompt: "complete" } },
        },
        {
          executionId: "execution:done",
          cursor: "root-completed-spawn",
          sequence: 1,
          type: "child_run.spawned",
          createdAt: 2,
          data: { tool_call_id: "completed", child_execution_id: completedChildId },
        },
        {
          executionId: "execution:done",
          cursor: "root-failed-tool",
          sequence: 2,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "failed", tool_name: "task", input: { prompt: "fail" } },
        },
        {
          executionId: "execution:done",
          cursor: "root-failed-spawn",
          sequence: 3,
          type: "child_run.spawned",
          createdAt: 3,
          data: { tool_call_id: "failed", child_execution_id: failedChildId },
        },
        {
          executionId: "execution:done",
          cursor: "root-usage",
          sequence: 4,
          type: "model.usage.reported",
          createdAt: 7,
          data: {
            model_call_id: "root-call",
            model_attempt_id: "root-attempt",
            attempt: 1,
            provider: "openai",
            model: "gpt-5.6-sol",
            input_tokens: 20,
            input_tokens_uncached: 20,
            input_tokens_cache_read: 0,
            input_tokens_cache_write: 0,
            output_tokens: 10,
          },
        },
        {
          executionId: "execution:done",
          cursor: "root-cost",
          sequence: 5,
          type: "model.attempt.completed",
          createdAt: 7,
          data: {
            model_call_id: "root-call",
            model_attempt_id: "root-attempt",
            attempt: 1,
            cost: { amount: 1.25, currency: "USD" },
          },
        },
        {
          executionId: "execution:done",
          cursor: "root-failed",
          sequence: 6,
          type: "execution.failed",
          createdAt: 8,
          text: "resident was replaced during execution",
        },
      ]
      const completedChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
        {
          executionId: completedChildId,
          cursor: "nested-tool",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 3,
          data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "nested work" } },
        },
        {
          executionId: completedChildId,
          cursor: "nested-spawn",
          sequence: 1,
          type: "child_run.spawned",
          createdAt: 4,
          data: { tool_call_id: "nested", child_execution_id: nestedChildId },
        },
        {
          executionId: completedChildId,
          cursor: "completed-child",
          sequence: 2,
          type: "execution.completed",
          createdAt: 7,
        },
      ]
      const failedChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
        {
          executionId: failedChildId,
          cursor: "failed-child",
          sequence: 0,
          type: "execution.failed",
          createdAt: 6,
          text: "child checks failed",
        },
      ]
      const nestedChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
        {
          executionId: nestedChildId,
          cursor: "nested-answer",
          sequence: 0,
          type: "model.output.completed",
          createdAt: 5,
          text: "Nested child completed authoritatively.",
        },
        {
          executionId: nestedChildId,
          cursor: "nested-completed",
          sequence: 1,
          type: "execution.completed",
          createdAt: 6,
        },
      ]
      const stale = Transcript.project("done", "delegate", rootEvents.slice(0, 4))
      const inspections: Readonly<Record<string, ExecutionBackend.Inspection>> = {
        done: {
          turnId: "done",
          status: "failed",
          lastCursor: "root-failed",
          waits: [],
          pendingTools: [],
          children: [
            { executionId: completedChildId, status: "completed" },
            { executionId: failedChildId, status: "failed" },
          ],
        },
        [completedChildId]: {
          turnId: completedChildId,
          status: "completed",
          lastCursor: "completed-child",
          waits: [],
          pendingTools: [],
          children: [{ executionId: nestedChildId, status: "completed" }],
        },
        [failedChildId]: {
          turnId: failedChildId,
          status: "failed",
          lastCursor: "failed-child",
          waits: [],
          pendingTools: [],
          children: [],
        },
        [nestedChildId]: {
          turnId: nestedChildId,
          status: "completed",
          lastCursor: "nested-completed",
          waits: [],
          pendingTools: [],
          children: [],
        },
      }
      const replayEvents: Readonly<Record<string, ReadonlyArray<ExecutionBackend.Event>>> = {
        done: rootEvents,
        [completedChildId]: completedChildEvents,
        [failedChildId]: failedChildEvents,
        [nestedChildId]: nestedChildEvents,
      }
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree: stale,
        turnLastCursor: "root-failed-spawn",
        childReplayEvents: [],
        turnStatus: "running",
        inspection: (executionId) => inspections[executionId],
        replayEvents: (executionId) => replayEvents[executionId] ?? [],
      })

      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id)
      for (let attempt = 0; attempt < 400 && !events.some((event) => event._tag === "ThreadUsageUpdated"); attempt += 1)
        yield* Effect.yieldNow
      const root = entries.filter((entry) => entry.turn.id === "done" && entry.unit.parentId === undefined)
      const tools = root.flatMap((entry) =>
        entry.unit.content._tag === "Block" && entry.unit.content.block._tag === "ToolCall"
          ? [entry.unit.content.block]
          : [],
      )

      expect(root.every((entry) => entry.turn.status === "failed" && entry.turn.lastCursor === "root-failed")).toBe(
        true,
      )
      expect(root).toContainEqual(
        expect.objectContaining({
          unit: expect.objectContaining({
            content: expect.objectContaining({
              block: expect.objectContaining({
                _tag: "Error",
                title: "Execution failed",
                detail: "resident was replaced during execution",
              }),
            }),
          }),
        }),
      )
      expect(tools).toEqual([
        expect.objectContaining({ id: "done:completed", status: "complete" }),
        expect.objectContaining({ id: "done:failed", status: "failed" }),
      ])
      expect(
        entries.find(
          (entry) =>
            entry.unit.turnId === completedChildId &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.id === `${completedChildId}:nested`,
        )?.unit.content,
      ).toMatchObject({ _tag: "Block", block: { _tag: "ToolCall", status: "complete" } })
      expect(
        entries.some(
          (entry) =>
            entry.unit.turnId === nestedChildId &&
            entry.unit.content._tag === "Entry" &&
            entry.unit.content.text === "Nested child completed authoritatively.",
        ),
      ).toBe(true)
      expect(
        entries.some(
          (entry) =>
            entry.unit.content._tag === "Block" &&
            (entry.unit.content.block._tag === "ToolCall" || entry.unit.content.block._tag === "ChildAgent") &&
            entry.unit.content.block.status === "running",
        ),
      ).toBe(false)
      expect(events.find((event) => event._tag === "ThreadUsageUpdated")).toMatchObject({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 1,
        threadId: "subagent-thread",
        cost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0 },
        tokens: { _tag: "Available", total: 30, uncountedAttempts: 0 },
        time: { _tag: "Unavailable" },
      })
    }),
  )

  it.effect("renders an already-completed child from persisted units after following it once", () =>
    Effect.gen(function* () {
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const rootProjection = Transcript.project("done", "delegate", subagentRootEvents.slice(0, 2))
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree: rootProjection,
        turnLastCursor: subagentRootEvents[1]!.cursor,
        childReplayEvents: subagentChildEvents,
        turnStatus: "running",
        followed,
      })

      const { entries } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
      expect((yield* Ref.get(followed)).filter((executionId) => executionId === subagentChildId)).toHaveLength(1)
    }),
  )

  it.effect("rediscovers an active nested follower below a failed root during reload", () =>
    Effect.gen(function* () {
      const nestedId = `child:${encodeURIComponent(subagentChildId)}:nested`
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
        {
          executionId: subagentChildId,
          cursor: "nested-call",
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "nested" } },
        },
        {
          executionId: subagentChildId,
          cursor: "nested-spawn",
          sequence: 2,
          type: "child_run.spawned",
          createdAt: 3,
          data: { tool_call_id: "nested", child_execution_id: nestedId },
        },
        {
          executionId: subagentChildId,
          cursor: "child-complete",
          sequence: 3,
          type: "execution.completed",
          createdAt: 5,
        },
      ]
      const nestedEvents: ReadonlyArray<ExecutionBackend.Event> = [
        { executionId: nestedId, cursor: "nested-complete", sequence: 1, type: "execution.completed", createdAt: 4 },
      ]
      const inspection = (executionId: string): ExecutionBackend.Inspection => {
        let children: ExecutionBackend.Inspection["children"] = []
        if (executionId === "done") children = [{ executionId: subagentChildId, status: "completed" }]
        else if (executionId === subagentChildId) children = [{ executionId: nestedId, status: "running" }]
        let status: ExecutionBackend.Status = "running"
        if (executionId === "done") status = "failed"
        else if (executionId === subagentChildId) status = "completed"
        return {
          turnId: executionId,
          status,
          waits: [],
          pendingTools: [],
          children,
        }
      }
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents.slice(0, 2)),
        turnLastCursor: subagentRootEvents[1]!.cursor,
        childReplayEvents: childEvents,
        turnStatus: "failed",
        followed,
        inspection,
        replayEvents: (executionId) => {
          if (executionId === subagentChildId) return childEvents
          if (executionId === nestedId) return nestedEvents
          return []
        },
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(subagentThread.id, 1)
      for (
        let attempt = 0;
        attempt < 400 &&
        !events.some((event) => event._tag === "TranscriptPatched" && event.event.cursor === "nested-complete");
        attempt += 1
      )
        yield* Effect.yieldNow

      expect(yield* Ref.get(followed)).toContain(nestedId)
      expect(
        events.some(
          (event) =>
            event._tag === "TranscriptPatched" && event.turnId === nestedId && event.event.cursor === "nested-complete",
        ),
      ).toBe(true)
    }),
  )

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
      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      expect(events.filter((event) => event._tag === "SelectionLoaded")).toHaveLength(1)
      expect(events.filter((event) => event._tag === "TranscriptReplaced").length).toBeLessThanOrEqual(1)
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
    }),
  )

  it.effect("consumes a child with no replayable transcript once and never follows it again", () =>
    Effect.gen(function* () {
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: [],
        followed,
        inspection: (executionId) => ({
          turnId: executionId,
          status: "completed",
          ...(executionId === "done" ? { lastCursor: "done-final" } : {}),
          waits: [],
          pendingTools: [],
          children: executionId === "done" ? [{ executionId: subagentChildId, status: "completed" }] : [],
        }),
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(stored?.consumed?.[subagentChildId]?.status).toBe("completed")
      expect(stored?.childTreeReconciled).toBe(true)
      const consumedFollows = yield* Ref.get(followed)

      yield* session.reopenThread(2)
      for (let attempt = 0; attempt < 200; attempt += 1) yield* Effect.yieldNow
      expect(yield* Ref.get(followed)).toEqual(consumedFollows)
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
      const { entries } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
    }),
  )

  it.effect("does not replay a reconciled terminal child tree when the thread reopens", () =>
    Effect.gen(function* () {
      const rootProjection = Transcript.project("done", "delegate", subagentRootEvents)
      const childProjection = Transcript.project(subagentChildId, "", subagentChildEvents)
      const attributedChildEvents = subagentChildEvents.map((event) => ({
        ...event,
        childExecutionId: subagentChildId,
      }))
      const storedTree = Transcript.withNestedProjections(rootProjection, [
        { parentId: subagentToolId, projection: childProjection },
      ])
      let inspections = 0
      let eventPages = 0
      const inspection = (executionId: string): ExecutionBackend.Inspection => {
        inspections += 1
        return {
          turnId: executionId,
          status: "completed",
          lastCursor: executionId === "done" ? "done-final" : "childdone~a4",
          waits: [],
          pendingTools: [],
          children: executionId === "done" ? [{ executionId: subagentChildId, status: "completed" }] : [],
        }
      }
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        inspection,
        replayEvents: (executionId) => {
          eventPages += 1
          if (executionId === "done") return subagentRootEvents
          return executionId === subagentChildId ? attributedChildEvents : []
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const repairedInspections = inspections
      const repairedPages = eventPages
      expect(repairedInspections).toBeGreaterThan(0)
      expect(repairedPages).toBeGreaterThan(0)

      yield* session.reopenThread(2)
      expect(inspections).toBe(repairedInspections + 1)
      expect(eventPages).toBe(repairedPages)
    }),
  )

  it.effect("does not mark a persisted terminal turn reconciled while Relay reports active execution", () =>
    Effect.gen(function* () {
      let inspections = 0
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: [],
        inspection: (executionId) => {
          inspections += 1
          return {
            turnId: executionId,
            status: "running",
            lastCursor: "done-final",
            waits: [],
            pendingTools: [],
            children: [],
          }
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      expect((yield* transcripts.get(Turn.TurnId.make("done")))?.childTreeReconciled).toBe(false)
      const firstInspections = inspections
      yield* session.reopenThread(2)
      expect(inspections).toBeGreaterThan(firstInspections)
    }),
  )

  it.effect("leaves a descendant unconsumed until Relay can read it", () =>
    Effect.gen(function* () {
      let childAvailable = false
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        inspection: (executionId) => {
          if (executionId !== "done")
            return childAvailable
              ? {
                  turnId: executionId,
                  status: "running",
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined
          return {
            turnId: executionId,
            status: "completed",
            lastCursor: "done-final",
            waits: [],
            pendingTools: [],
            children: [{ executionId: subagentChildId, status: "completed" }],
          }
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const unreadable = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(unreadable?.childTreeReconciled).toBe(false)
      expect(unreadable?.consumed?.[subagentChildId]?.status).toBeUndefined()

      childAvailable = true
      yield* session.reopenThread(2)
      for (
        let attempt = 0;
        attempt < 400 && (yield* transcripts.get(Turn.TurnId.make("done")))?.childTreeReconciled !== true;
        attempt += 1
      )
        yield* Effect.yieldNow
      const readable = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(readable?.consumed?.[subagentChildId]?.status).toBe("completed")
      expect(
        readable?.units.some(
          (unit) =>
            unit.parentId === subagentToolId &&
            unit.content._tag === "Entry" &&
            unit.content.text.includes("All tests pass."),
        ),
      ).toBe(true)
    }),
  )

  it.effect("consumes a child that only inspection reveals before reconciling the tree", () =>
    Effect.gen(function* () {
      const lateChild = `${subagentChildId}:late`
      let rootInspections = 0
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        inspection: (executionId) => {
          if (executionId === "done") rootInspections += 1
          return {
            turnId: executionId,
            status: "completed",
            lastCursor: executionId === "done" ? "done-final" : "childdone~a4",
            waits: [],
            pendingTools: [],
            children:
              executionId !== "done"
                ? []
                : [
                    { executionId: subagentChildId, status: "completed" },
                    ...(rootInspections > 1 ? [{ executionId: lateChild, status: "completed" as const }] : []),
                  ],
          }
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      expect(rootInspections).toBeGreaterThan(1)
      const stored = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(Object.keys(stored?.consumed ?? {}).toSorted()).toEqual(["done", subagentChildId, lateChild].toSorted())
      expect(stored?.consumed?.[lateChild]?.status).toBe("completed")
      expect(stored?.childTreeReconciled).toBe(true)
    }),
  )

  it.effect("certifies only replayed root and child projections and excludes stored orphan children", () =>
    Effect.gen(function* () {
      const staleChild = Transcript.project(subagentChildId, "", [
        ...subagentChildEvents,
        {
          cursor: "stale-child",
          sequence: 100,
          type: "model.output.completed",
          createdAt: 100,
          text: "stale stored child",
        },
      ])
      const orphan = Transcript.project("orphan-child", "", [
        {
          cursor: "orphan-answer",
          sequence: 200,
          type: "model.output.completed",
          createdAt: 200,
          text: "orphan stored child",
        },
      ])
      const storedTree = Transcript.withNestedProjections(
        Transcript.project("done", "wrong stored prompt", subagentRootEvents),
        [
          { parentId: subagentToolId, projection: staleChild },
          { parentId: "orphan-parent", projection: orphan },
        ],
      )
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        replayEvents: (executionId) => (executionId === "done" ? subagentRootEvents : subagentChildEvents),
        inspection: (executionId) => ({
          turnId: executionId,
          status: "completed",
          lastCursor: executionId === "done" ? "done-final" : "childdone~a4",
          waits: [],
          pendingTools: [],
          children: executionId === "done" ? [{ executionId: subagentChildId, status: "completed" }] : [],
        }),
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(stored?.childTreeReconciled).toBe(true)
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "delegate")).toBe(true)
      expect(
        stored?.units.some(
          (unit) =>
            unit.content._tag === "Entry" && ["stale stored child", "orphan stored child"].includes(unit.content.text),
        ),
      ).toBe(false)
    }),
  )

  it.effect("keeps persisted root units when Relay can no longer replay the root", () =>
    Effect.gen(function* () {
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        replayEvents: (executionId) => (executionId === subagentChildId ? subagentChildEvents : []),
      })

      const { entries } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      expect(
        entries.some(
          (entry) =>
            entry.unit.parentId === undefined &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.id === subagentToolId,
        ),
      ).toBe(true)
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
      expect((yield* transcripts.get(Turn.TurnId.make("done")))?.consumed?.done?.status).toBe("completed")
    }),
  )
})

const spendThread = thread("spend-thread", 1)
const spendTurnId = Turn.TurnId.make("spend-turn")
const spendExecutionId = `execution:${String(spendTurnId)}`

const stamped = (
  cursor: string,
  type: "execution.started" | "execution.completed",
  createdAt: number,
  sequence: number,
): ExecutionBackend.Event =>
  ({
    executionId: spendExecutionId,
    cursor,
    sequence,
    type,
    createdAt,
    timestampSource: "server",
  }) as ExecutionBackend.Event

const spendEvents: ReadonlyArray<ExecutionBackend.Event> = [
  stamped("spend-started", "execution.started", 10_000, 1),
  {
    executionId: spendExecutionId,
    cursor: "spend-usage",
    sequence: 2,
    type: "model.attempt.completed",
    createdAt: 20_000,
    data: { model_attempt_id: "spend-attempt", attempt: 1, cost: { amount: 0.75, currency: "USD" } },
  },
  {
    executionId: spendExecutionId,
    cursor: "spend-answer",
    sequence: 3,
    type: "model.output.completed",
    createdAt: 30_000,
    text: "spent",
  },
]

const spendCompleted = stamped("spend-completed", "execution.completed", 40_000, 4)

const spendTimeline: ReadonlyArray<ExecutionBackend.Event> = [...spendEvents, spendCompleted]

const legacyUsageRow = () => {
  const snapshot = spendTimeline.reduce(
    (folded, event) =>
      UsageCost.observe(folded, { threadId: String(spendThread.id), turnId: String(spendTurnId), event }),
    UsageCost.empty,
  )
  const totals = UsageCost.materialize(snapshot, String(spendTurnId), String(spendThread.id))
  return {
    foldJson: JSON.stringify({
      ...(JSON.parse(UsageCost.serialize(snapshot)) as Record<string, unknown>),
      version: UsageCost.foldVersion - 1,
    }),
    totals: {
      ...(totals.costNanoUsd === undefined ? {} : { costNanoUsd: totals.costNanoUsd }),
      ...(totals.tokens === undefined ? {} : { tokens: totals.tokens }),
      pricedAttempts: totals.pricedAttempts,
      unpricedAttempts: totals.unpricedAttempts,
      countedAttempts: totals.countedAttempts,
      uncountedAttempts: totals.uncountedAttempts,
      sourceComplete: false,
    },
  }
}

const makeSpendHarness = Effect.fn("InteractiveSessionTest.makeSpendHarness")(function* (options: {
  readonly gate?: Deferred.Deferred<void>
  readonly turnStatus?: Turn.Status
  readonly legacy?: boolean
}) {
  const spendTurn: Turn.Turn = {
    id: spendTurnId,
    threadId: spendThread.id,
    prompt: "spend prompt",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    executionRoute: executionRoute(),
    status: options.turnStatus ?? "running",
    stopIntent: "none",
    createdAt: 1,
    updatedAt: 1,
  }
  const repositories = yield* ThreadRepository.makeMemory([spendThread])
  const turns = yield* TurnRepository.makeMemory([spendTurn])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const transcripts = Context.get(yield* Layer.build(TranscriptRepository.memoryLayer), TranscriptRepository.Service)
  const usage = Context.get(yield* Layer.build(UsageRepository.memoryLayer), UsageRepository.Service)
  const follows = yield* Ref.make(0)
  const blocked = yield* Ref.make(0)
  if (options.legacy === true) {
    yield* transcripts.replace(spendTurn, Transcript.project(String(spendTurnId), spendTurn.prompt, spendTimeline), {})
    const legacy = legacyUsageRow()
    yield* usage.admit(String(spendTurnId), String(spendThread.id))
    yield* usage.commitFold(String(spendTurnId), 0, legacy.foldJson, legacy.totals)
  }
  const terminal = {
    turnId: String(spendTurnId),
    status: "completed" as const,
    waits: [],
    pendingTools: [],
    children: [],
  }
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
    inspect: () =>
      Effect.succeed(
        options.turnStatus === undefined
          ? { ...terminal, status: "running" as const, lastCursor: "spend-answer" }
          : { ...terminal, lastCursor: "spend-completed" },
      ),
    follow: (turnId, cursor, onEvent) =>
      options.legacy === true
        ? Ref.update(follows, (count) => count + 1).pipe(
            Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
            Effect.andThen(
              Effect.sync(() => {
                const after = typeof cursor === "string" ? cursor : cursor?.cursor
                const boundary =
                  after === undefined ? -1 : spendTimeline.findIndex((candidate) => candidate.cursor === after)
                const pending = spendTimeline.slice(boundary + 1)
                for (const event of pending) onEvent?.(event)
                return { turnId: String(turnId), status: "completed" as const, events: pending }
              }),
            ),
          )
        : Ref.update(blocked, (count) => count + 1).pipe(
            Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
            Effect.andThen(Ref.updateAndGet(follows, (count) => count + 1)),
            Effect.tap((count) =>
              Effect.sync(() => {
                for (const event of count === 1 ? spendEvents : spendTimeline) onEvent?.(event)
              }),
            ),
            Effect.map((count) => ({
              turnId: String(turnId),
              status: count === 1 ? ("running" as const) : ("completed" as const),
              events: count === 1 ? spendEvents : spendTimeline,
            })),
          ),
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    replay: (turnId) =>
      Ref.update(blocked, (count) => count + 1).pipe(
        Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
        Effect.as({ turnId: String(turnId), status: "completed" as const, events: spendTimeline }),
      ),
    pageEvents: (turnId, _direction, cursor) =>
      Ref.update(blocked, (count) => count + 1).pipe(
        Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
        Effect.as({
          events: cursor === undefined ? spendTimeline : [],
          hasMore: false,
          newestCursor: "spend-completed",
          turnId: String(turnId),
        }),
      ),
    listApprovals: () => Effect.succeed([]),
    resolveToolApproval: () => Effect.void,
    resolvePermission: () => Effect.void,
    resolveInvocationSource: () => Effect.die("unused"),
  })
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
    usageRepositoryLayer: Layer.succeed(UsageRepository.Service, usage),
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
  return { session, usage, turns, transcripts, follows, blocked }
})

describe("InteractiveSession persisted usage", () => {
  it.effect("never displays more than the persisted total when the same events are delivered again", () =>
    Effect.gen(function* () {
      const { session, usage, follows } = yield* makeSpendHarness({})
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(spendThread.id, 1)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle
      const persisted = yield* usage.readThread(String(spendThread.id))
      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(yield* Ref.get(follows)).toBeGreaterThan(1)
      expect(persisted.costNanoUsd).toBe(750_000_000)
      expect(shown.length).toBeGreaterThan(0)
      expect(Math.max(...shown)).toBe(0.75)
      expect(shown.every((usd) => usd <= 0.75)).toBe(true)
      expect(shown).toEqual([...shown].toSorted((left, right) => left - right))
      const availability = updates.map((event) => event.time._tag)
      expect(availability.slice(availability.indexOf("Available")).includes("Unavailable")).toBe(false)
      expect(updates.at(-1)?.time).toEqual({ _tag: "Available", accumulatedMillis: 30_000 })
      expect(persisted.activeMillis).toBe(30_000)
    }),
  )

  it.effect("holds the displayed total when the same events are replayed into the feed after reselecting", () =>
    Effect.gen(function* () {
      const { session, usage } = yield* makeSpendHarness({ turnStatus: "completed" })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )
      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle
      const persisted = yield* usage.readThread(String(spendThread.id))
      expect(persisted.costNanoUsd).toBe(750_000_000)

      yield* session.selectThread(spendThread.id, 2)
      for (let attempt = 0; attempt < 5; attempt += 1) yield* settle
      const beforeReplay = events.length
      yield* session.replay(String(spendTurnId), undefined)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      const patched = events
        .slice(beforeReplay)
        .filter((event) => event._tag === "TranscriptPatched" && String(event.turnId) === String(spendTurnId))
      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(patched.length).toBeGreaterThan(0)
      expect(updates.some((event) => event.selectionEpoch === 2)).toBe(true)
      expect(shown.length).toBeGreaterThan(0)
      expect(Math.max(...shown)).toBe(0.75)
      expect(shown.every((usd) => usd <= 0.75)).toBe(true)
      expect(updates.at(-1)?.cost).toEqual({ _tag: "Available", usd: 0.75, unpricedAttempts: 0 })
      const availability = updates.map((event) => event.time._tag)
      expect(availability.slice(availability.indexOf("Available")).includes("Unavailable")).toBe(false)
      expect((yield* usage.readThread(String(spendThread.id))).costNanoUsd).toBe(750_000_000)
    }),
  )

  it.effect("recomputes cost and elapsed time for a legacy turn whose stored fold is unreadable", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session, usage, transcripts, follows } = yield* makeSpendHarness({
        turnStatus: "completed",
        legacy: true,
        gate,
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )
      expect((yield* transcripts.get(spendTurnId))?.projectionVersion).toBe(
        TranscriptRepository.legacyProjectionVersion,
      )
      expect((yield* transcripts.get(spendTurnId))?.consumed).toBeUndefined()
      expect((yield* usage.readTurn(String(spendTurnId)))?.costNanoUsd).toBe(750_000_000)
      expect((yield* usage.readTurn(String(spendTurnId)))?.activeMillis).toBeUndefined()
      expect((yield* usage.readThread(String(spendThread.id))).activeMillis).toBeUndefined()

      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 5; attempt += 1) yield* settle
      const beforeRefold = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      expect(beforeRefold.length).toBeGreaterThan(0)
      expect(beforeRefold.every((event) => event.time._tag === "Unavailable")).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      const refolded = yield* transcripts.get(spendTurnId)
      const persistedTurn = yield* usage.readTurn(String(spendTurnId))
      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const availability = updates.map((event) => event.time._tag)
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(refolded?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(refolded?.consumed?.[Transcript.executionKey(String(spendTurnId))]?.status).toBe("completed")
      expect(persistedTurn?.activeMillis).toBe(30_000)
      expect(persistedTurn?.costNanoUsd).toBe(750_000_000)
      expect((yield* usage.readThread(String(spendThread.id))).activeMillis).toBe(30_000)
      expect(availability[0]).toBe("Unavailable")
      expect(availability).toContain("Available")
      expect(availability.slice(availability.indexOf("Available")).includes("Unavailable")).toBe(false)
      expect(updates.at(-1)?.time).toEqual({ _tag: "Available", accumulatedMillis: 30_000 })
      expect(shown.length).toBeGreaterThan(0)
      expect(Math.max(...shown)).toBe(0.75)
      expect(shown.every((usd) => usd <= 0.75)).toBe(true)
      expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(yield* Ref.get(follows)).toBe(1)
    }),
  )

  it.effect("announces the refold while a legacy thread rebuilds and withdraws it once the projection lands", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session } = yield* makeSpendHarness({ turnStatus: "completed", legacy: true, gate })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      const settle = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true }).pipe(
        Effect.andThen(TestClock.adjust("1 second")),
        Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })),
      )

      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 5; attempt += 1) yield* settle
      const announced = events.flatMap((event) => (event._tag === "ThreadRefolding" ? [event] : []))
      expect(announced.map((event) => event.refolding)).toEqual([true])
      expect(announced.every((event) => event.threadId === spendThread.id)).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      expect(events.flatMap((event) => (event._tag === "ThreadRefolding" ? [event.refolding] : []))).toEqual([
        true,
        false,
      ])
    }),
  )

  it.effect("loads a selection while ingest catch-up is still blocked", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session, turns, blocked } = yield* makeSpendHarness({ gate, turnStatus: "completed" })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(spendThread.id, 1)
      for (let attempt = 0; attempt < 400 && !events.some((event) => event._tag === "SelectionLoaded"); attempt += 1)
        yield* Effect.yieldNow

      expect(events.some((event) => event._tag === "SelectionLoaded")).toBe(true)
      expect(yield* Ref.get(blocked)).toBeGreaterThan(0)
      expect(yield* turns.get(spendTurnId)).toMatchObject({ status: "completed" })
      yield* Deferred.succeed(gate, undefined)
    }),
  )
})
