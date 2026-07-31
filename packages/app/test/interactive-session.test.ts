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
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as ExecutionIngest from "../src/execution-ingest"
import { Operation } from "../src/index"
import * as UsageCost from "../src/usage-cost"
import { createTurn, executionRoute } from "./current-state"
import { delegationUnit, invalidatedProjection, storeProjection } from "./transcript-repository-fixture"

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

const active = (threadId: Thread.ThreadId, id = "active"): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
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

const serverEvents = (events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event> =>
  events.map((event) => ({ ...event, timestampSource: "server" as const }))

const completeServerTimeline = (
  events: ReadonlyArray<ExecutionBackend.Event>,
): ReadonlyArray<ExecutionBackend.Event> => {
  if (events.length === 0) return events
  const stamped = serverEvents(events)
  if (stamped.some((event) => event.type === "execution.started" || event.type === "execution.accepted")) return stamped
  const first = stamped[0]!
  return [
    {
      executionId: first.executionId,
      cursor: `${first.executionId}:started`,
      sequence: 0,
      type: "execution.started",
      createdAt: first.createdAt - 1,
      timestampSource: "server",
    },
    ...stamped.map((event, index) => Object.assign({}, event, { sequence: index + 1 })),
  ]
}

const storeCompletedTranscript = Effect.fn("InteractiveSessionTest.storeCompletedTranscript")(function* (
  transcripts: TranscriptRepository.Interface,
  turn: Turn.AgentExecutionTurn,
  cursor: string,
) {
  const projection = Transcript.project(String(turn.id), turn.prompt, [
    {
      cursor,
      sequence: 0,
      type: "execution.completed",
      createdAt: turn.updatedAt,
    },
  ])
  yield* storeProjection(transcripts, turn, projection, {
    consumed: { [String(turn.id)]: { cursor, sequence: 0, status: "completed" } },
    projectionVersion: ExecutionIngest.projectionVersion,
  })
})

const completeActive = Effect.fn("InteractiveSessionTest.completeActive")(function* (
  turns: TurnRepository.Interface,
  transcripts: TranscriptRepository.Interface,
  updatedAt: number,
) {
  const turn = yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", updatedAt)
  yield* storeCompletedTranscript(transcripts, turn, "done")
  return turn
})

const makeHarness = Effect.fn("InteractiveSessionTest.makeHarness")(function* (
  pagedEvents?: ReadonlyArray<ExecutionBackend.Event>,
  stalePageCursor: boolean = false,
  turnPageRequests?: Ref.Ref<ReadonlyArray<TurnRepository.PageCursor | undefined>>,
  cancelFailure: boolean = false,
  initialTurnsCompleted: boolean = false,
  completion?: {
    readonly release: Deferred.Deferred<void, never>
    readonly finished: Deferred.Deferred<void, never>
    readonly finalTurnId: Turn.TurnId
  },
) {
  const older = thread("older", 1)
  const latest = thread("latest", 2)
  const initialTurns = [active(older.id), active(latest.id, "latest-active")].map((turn) =>
    initialTurnsCompleted
      ? Object.assign({}, turn, {
          status: "completed" as const,
          lastCursor: `${turn.id}-completed`,
          updatedAt: 2,
        })
      : turn,
  )
  const repositories = yield* ThreadRepository.makeMemory([older, latest])
  const turns = yield* TurnRepository.makeMemory(initialTurns)
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const controls = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
  const hiddenExecutions = yield* Ref.make<ReadonlySet<string>>(new Set())
  const transcripts = yield* TranscriptRepository.makeMemory({ turns })
  if (initialTurnsCompleted)
    yield* Effect.forEach(initialTurns, (turn) => storeCompletedTranscript(transcripts, turn, turn.lastCursor!), {
      discard: true,
    })
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
      completion !== undefined
        ? record("start", input.turnId).pipe(
            Effect.tap(() =>
              input.turnId === completion.finalTurnId ? Deferred.succeed(completion.finished, undefined) : Effect.void,
            ),
            Effect.as({
              turnId: input.turnId,
              status: "completed" as const,
              events: serverEvents([
                {
                  executionId: input.turnId,
                  cursor: "queued-started",
                  sequence: 0,
                  type: "execution.started",
                  createdAt: 2,
                },
                {
                  executionId: input.turnId,
                  cursor: "queued-done",
                  sequence: 1,
                  type: "execution.completed",
                  createdAt: 3,
                },
              ]),
            }),
          )
        : Effect.die("unused"),
    ...(completion !== undefined
      ? {
          follow: (
            turnId: string,
            checkpoint: string | ExecutionBackend.ExecutionCheckpoint | undefined,
            onEvent?: (event: ExecutionBackend.Event) => void,
          ) => {
            const afterCursor = typeof checkpoint === "string" ? checkpoint : checkpoint?.cursor
            const output: ExecutionBackend.Event = {
              executionId: turnId,
              cursor: "resumed-output",
              sequence: 2,
              type: "model.output.completed",
              createdAt: 2,
              timestampSource: "server",
              text: "created file",
            }
            const completed: ExecutionBackend.Event = {
              executionId: turnId,
              cursor: "resumed-done",
              sequence: 3,
              type: "execution.completed",
              createdAt: 3,
              timestampSource: "server",
            }
            return record("follow", turnId, afterCursor).pipe(
              Effect.andThen(turnId === "active" ? Deferred.await(completion.release) : Effect.void),
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
    steer: (turnId, text, idempotencyIdentity) =>
      record("steer", turnId, text, idempotencyIdentity).pipe(
        Effect.as({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
      ),
    cancel: (turnId) =>
      record("cancel", turnId).pipe(
        Effect.andThen(
          cancelFailure
            ? Effect.fail(ExecutionBackend.BackendError.make({ message: "cancel unavailable" }))
            : Effect.void,
        ),
        Effect.as({
          turnId,
          status: "cancelled" as const,
          events: serverEvents([
            {
              executionId: turnId,
              cursor: "cancel-cursor",
              sequence: 1,
              type: "execution.cancelled",
              createdAt: 1,
            },
          ]),
        }),
      ),
    replay: (turnId, cursor) =>
      record("replay", turnId, cursor).pipe(
        Effect.as({
          turnId,
          status: "running" as const,
          events:
            cursor === undefined
              ? serverEvents([
                  {
                    executionId: turnId,
                    cursor: "active-cursor",
                    sequence: 0,
                    type: "execution.started",
                    createdAt: 0,
                  },
                ])
              : [],
          lastCursor: cursor ?? "active-cursor",
        }),
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
      yield* Effect.all([alpha.shell(undefined, "pwd", true), beta.shell(undefined, "pwd", true)])
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
            events: serverEvents([
              {
                executionId: input.turnId,
                cursor: "started",
                sequence: 0,
                type: "execution.started",
                createdAt: 0,
              },
              {
                executionId: input.turnId,
                cursor: "output",
                sequence: 1,
                type: "model.output.completed",
                createdAt: 1,
              },
              {
                executionId: input.turnId,
                cursor: "done",
                sequence: 2,
                type: "execution.completed",
                createdAt: 2,
              },
            ]),
          }),
        replay: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
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
      while (!events.some((event) => event._tag === "TranscriptProjectionStopped")) yield* Effect.yieldNow
      expect(
        events.filter(
          (event) =>
            event._tag !== "ThreadsListed" &&
            event._tag !== "TranscriptProjectionStarted" &&
            event._tag !== "TranscriptProjectionStopped",
        ),
      ).toMatchObject([
        { _tag: "ThreadActivated", threadId: "created", title: "New thread" },
        {
          _tag: "SelectionLoaded",
          selectionEpoch: 0,
          thread: { id: "created" },
          entries: [],
        },
        {
          _tag: "ThreadRefolding",
          selectionEpoch: 0,
          threadId: "created",
          refolding: false,
        },
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
          _tag: "TranscriptProjectionPatched",
          selectionEpoch: 0,
          threadId: "created",
          rootTurnId: "created-turn",
          origin: {
            _tag: "Event",
            executionId: "created-turn",
            cursor: "started",
            sequence: 0,
            type: "execution.started",
            createdAt: 0,
            transient: false,
          },
          delta: expect.any(Object),
        },
        {
          _tag: "TranscriptProjectionPatched",
          selectionEpoch: 0,
          threadId: "created",
          rootTurnId: "created-turn",
          origin: {
            _tag: "Event",
            executionId: "created-turn",
            cursor: "output",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 1,
            transient: false,
          },
          delta: expect.any(Object),
        },
        {
          _tag: "TranscriptProjectionPatched",
          selectionEpoch: 0,
          threadId: "created",
          rootTurnId: "created-turn",
          origin: {
            _tag: "Event",
            executionId: "created-turn",
            cursor: "done",
            sequence: 2,
            type: "execution.completed",
            createdAt: 2,
            transient: false,
          },
          delta: expect.any(Object),
        },
        {
          _tag: "ThreadUsageUpdated",
          selectionEpoch: 0,
          threadId: "created",
          revision: 1,
          time: { _tag: "Available", accumulatedMillis: 2 },
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
      const cancellationProjected = () =>
        events.some(
          (event) =>
            event._tag === "TranscriptProjectionPatched" &&
            event.origin._tag === "Event" &&
            event.origin.type === "execution.cancelled",
        )
      for (let attempts = 0; attempts < 100 && !cancellationProjected(); attempts += 1) yield* Effect.yieldNow
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["steer", "active", "change course", "rika:interactive-steer:active:0"],
        ["cancel", "active"],
      ])
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancel-cursor",
      })
      expect(events).toContainEqual(
        expect.objectContaining({
          _tag: "TranscriptProjectionPatched",
          rootTurnId: "active",
          origin: expect.objectContaining({
            _tag: "Event",
            cursor: "cancel-cursor",
            type: "execution.cancelled",
          }),
          rootStatus: "cancelled",
        }),
      )
      expect(events).toContainEqual({
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
            events: serverEvents([
              {
                executionId: input.turnId,
                cursor: "replacement-started",
                sequence: 0,
                type: "execution.started",
                createdAt: 3,
              },
              {
                executionId: input.turnId,
                cursor: "replacement-done",
                sequence: 1,
                type: "execution.completed",
                createdAt: 4,
              },
            ]),
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
            Effect.as({
              turnId,
              status: "cancelled" as const,
              events: serverEvents([
                {
                  executionId: turnId,
                  cursor: "interrupt-started",
                  sequence: 0,
                  type: "execution.started",
                  createdAt: 2,
                },
                {
                  executionId: turnId,
                  cursor: "interrupt-cancelled",
                  sequence: 1,
                  type: "execution.cancelled",
                  createdAt: 3,
                },
              ]),
            }),
          ),
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
      const cancellationProjected = () =>
        events.some(
          (event) =>
            event._tag === "TranscriptProjectionPatched" &&
            event.origin._tag === "Event" &&
            event.origin.cursor === "interrupt-cancelled",
        )
      for (let attempts = 0; attempts < 100 && !cancellationProjected(); attempts += 1) yield* Effect.yieldNow
      expect(yield* Ref.get(persistedAtCancel)).toMatchObject({ prompt: "next prompt", status: "queued" })
      expect((yield* turns.get(Turn.TurnId.make("active")))?.status).toBe("cancelled")
      expect(cancellationProjected()).toBe(true)
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

  it.effect("starts every queued turn exactly once after a waiting turn completes", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      const finalTurnId = Turn.TurnId.make("promoted-three")
      const { session, turns, controls, older } = yield* makeHarness(undefined, false, undefined, false, false, {
        release,
        finished,
        finalTurnId,
      })
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
      const selection = yield* Effect.forkChild(session.selectThread(older.id, 1))
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(finished)
      yield* Fiber.join(selection)
      const calls = yield* Ref.get(controls)
      expect(calls.filter((call) => call[0] === "start")).toEqual([
        ["start", "promoted-one"],
        ["start", "promoted-two"],
        ["start", "promoted-three"],
      ])
      expect(calls.some((call) => call[0] === "follow" && String(call[1]).startsWith("promoted-"))).toBe(false)
    }),
  )

  it.effect(
    "runs shell input without approval, keeps incognito output transient, and records alongside active work",
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
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
              replay: () => Effect.die("unused"),
              steer: () => Effect.die("unused"),
              cancel: () => Effect.die("unused"),
              resolveInvocationSource: () => Effect.die("unused"),
            }),
          ),
          toolRuntimeLayer: () =>
            ToolRuntime.testLayer((request) => {
              const command = request._tag === "Shell" ? request.args.join(" ") : request._tag
              return Ref.update(commands, (values) => [...values, command]).pipe(
                Effect.as({ text: `output:${command}`, truncated: false, exitCode: 0 }),
              )
            }),
          defaultWorkspace: "/work",
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
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("Missing interactive session")
        const allEvents: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(session, allEvents)

        const runShell = Effect.fn("InteractiveSessionTest.runShell")(function* (command: string, incognito: boolean) {
          const first = allEvents.length
          yield* session.shell(undefined, command, incognito)
          while (!allEvents.slice(first).some((event) => event._tag === "ShellCompleted" && event.command === command))
            yield* Effect.yieldNow
          return allEvents.slice(first)
        })

        const persisted = yield* runShell("printf persisted", false)
        const shellSelectionIndex = persisted.findIndex((event) => event._tag === "SelectionLoaded")
        const shellSnapshotIndex = persisted.findIndex((event) => event._tag === "TranscriptProjectionStarted")
        expect(shellSelectionIndex).toBeGreaterThanOrEqual(0)
        expect(shellSnapshotIndex).toBeGreaterThan(shellSelectionIndex)
        expect(persisted.filter((event) => event._tag === "SelectionLoaded")).toHaveLength(1)
        expect(persisted[shellSelectionIndex]).toMatchObject({
          selectionEpoch: 0,
          thread: { id: "shell-thread" },
          entries: [],
        })
        expect(persisted.filter((event) => event._tag === "TranscriptProjectionStarted")).toHaveLength(1)
        expect(persisted.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: false })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread")))[0]).toMatchObject({
          _tag: "RecordedShell",
          prompt: "$ printf persisted",
          status: "completed",
          result: { text: "output:-lc printf persisted", truncated: false, exitCode: 0 },
        })

        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted"])

        const beforeIncognito = (yield* turns.list(Thread.ThreadId.make("shell-thread"))).length
        const incognito = yield* runShell("printf secret", true)
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
        const concurrentStart = allEvents.length
        yield* session.shell(Thread.ThreadId.make("shell-thread"), "printf alongside", false)
        while (!allEvents.slice(concurrentStart).some((event) => event._tag === "ShellCompleted"))
          yield* Effect.yieldNow
        const concurrent = allEvents.slice(concurrentStart)
        expect(concurrent.some((event) => event._tag === "QueueUpdated")).toBe(false)
        expect(
          (yield* turns.list(Thread.ThreadId.make("shell-thread"))).find(
            (turn) => Turn.isRecordedShell(turn) && turn.command === "printf alongside",
          ),
        ).toMatchObject({
          _tag: "RecordedShell",
          status: "completed",
          result: { text: "output:-lc printf alongside", exitCode: 0 },
        })
        expect(yield* turns.get(Turn.TurnId.make("active-shell-blocker"))).toMatchObject({ status: "running" })
      }),
  )

  it.effect("selects a thread and reopens the latest persisted projection without raw replay", () =>
    Effect.gen(function* () {
      const { session, controls, older } = yield* makeHarness(undefined, false, undefined, false, true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.reopenThread(2)
      while (!events.some((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2))
        yield* Effect.yieldNow
      const reopened = yield* awaitSelectionEntries(events, (entries) =>
        entries.some((entry) => entry.turn.id === "latest-active"),
      )
      expect(events.some((event) => event._tag === "SelectionLoaded" && event.thread.id === "older")).toBe(true)
      expect(reopened.map((entry) => entry.turn.id)).toEqual(["latest-active"])
      expect(events.filter((event) => event._tag === "TranscriptProjectionPatched")).toEqual([])
      expect(events.find((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2)).toEqual({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 2,
        threadId: "latest",
        revision: 0,
        cost: { _tag: "Unavailable" },
        tokens: { _tag: "Unavailable" },
        time: { _tag: "Unavailable" },
      })
      expect(yield* Ref.get(controls)).toEqual([])
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
      const { session, controls, older } = yield* makeHarness(pagedEvents)
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
      const { session, controls, older } = yield* makeHarness(pagedEvents, true)
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
      const { session, turns, transcripts, controls, older } = yield* makeHarness()
      const queued = yield* createTurn(turns, {
        id: Turn.TurnId.make("queued-selection"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 2,
      })
      const shell: Turn.TerminalRecordedShellTurn = {
        _tag: "RecordedShell",
        id: Turn.TurnId.make("recorded-shell"),
        threadId: older.id,
        prompt: "$ printf recorded",
        command: "printf recorded",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        status: "completed",
        stopIntent: "none",
        createdAt: 3,
        updatedAt: 4,
        result: { text: "output:recorded", truncated: false },
      }
      yield* transcripts.copyRecordedShell(shell, ExecutionIngest.projectionVersion)
      yield* completeActive(turns, transcripts, 5)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "SelectionLoaded")).toMatchObject({ queue: [{ id: queued.id }] })
      const entries = yield* awaitSelectionEntries(events, (loaded) => loaded.length >= 2)
      expect(entries).toMatchObject([
        { turn: { id: "active" }, unit: { content: { _tag: "Entry" } } },
        {
          turn: { id: shell.id },
          unit: { content: { _tag: "Block", block: { _tag: "ToolCall", output: "output:recorded" } } },
        },
      ])
      expect(entries.some((entry) => entry.turn.id === queued.id)).toBe(false)
      expect(entries.some((entry) => entry.turn.id === shell.id)).toBe(true)
      expect(yield* Ref.get(controls)).toEqual([])
    }),
  )

  it.effect("bounds the initial page and exhausts older pages without duplicate units", () =>
    Effect.gen(function* () {
      const turnPageRequests = yield* Ref.make<ReadonlyArray<TurnRepository.PageCursor | undefined>>([])
      const { session, turns, transcripts, older } = yield* makeHarness(undefined, false, turnPageRequests)
      yield* completeActive(turns, transcripts, 2)
      for (let index = 0; index < 240; index += 1) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(`history-${index.toString().padStart(3, "0")}`),
          threadId: older.id,
          prompt: `history ${index}`,
          now: index + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, index + 10)
        yield* storeCompletedTranscript(transcripts, completed, `history-${index}-done`)
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
      expect(hasOlder).toBe(false)
      expect(new Set(loaded.map((entry) => entry.unit.key)).size).toBe(loaded.length)
      expect(loaded.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === "turn:history-000:user")).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === "turn:history-239:user")).toBe(true)
      expect(yield* Ref.get(turnPageRequests)).toHaveLength(turnPagesBeforeIdle)
      expect(events.filter((event) => event._tag === "TranscriptPagePrepended").length).toBeGreaterThan(0)
    }),
  )

  it.effect("stops the initial semantic page at the nearest Turn boundary", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* completeActive(turns, transcripts, 2)
      for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(`boundary-${turnIndex}`),
          threadId: older.id,
          prompt: `boundary ${turnIndex}`,
          now: turnIndex + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, turnIndex + 10)
        const units: Array<Transcript.Unit> = [
          Transcript.empty(created.id, created.prompt).units[0]!,
          ...Array.from(
            { length: 72 },
            (_, index): Transcript.Unit => ({
              key: `${created.id}:assistant:${index.toString().padStart(2, "0")}`,
              turnId: created.id,
              order: Transcript.unitOrder(`${created.id}:assistant:${index.toString().padStart(2, "0")}`, index + 1),
              revision: index + 1,
              content: { _tag: "Entry", role: "assistant", text: `${created.id} ${index} ${"x".repeat(50_000)}` },
            }),
          ),
        ]
        yield* storeProjection(transcripts, completed, {
          ...Transcript.empty(created.id, created.prompt),
          units,
          revision: 72,
        })
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const initial = yield* awaitSelectionLoaded(
        events,
        (event) => event.entries.length > 0 && event.oldestCursor !== undefined,
      )
      const loaded = initial.entries
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(initial)
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(10 * 1024 * 1024)
      expect(loaded.length).toBeGreaterThan(0)
      expect(loaded[0]?.unit.key).toBe(`turn:${loaded[0]?.turn.id}:user`)
      expect(initial.hasOlder).toBe(true)
      if (initial.oldestCursor === undefined) return yield* Effect.die("missing initial transcript cursor")

      const pagesBefore = events.filter((event) => event._tag === "TranscriptPagePrepended").length
      yield* session.loadOlder(
        older.id,
        1,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
      const prepended = yield* awaitPrependedPage(events, pagesBefore)
      const olderEntries = prepended.entries
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
      yield* completeActive(turns, transcripts, 2)
      const created = yield* createTurn(turns, {
        id: Turn.TurnId.make("oversized"),
        threadId: older.id,
        prompt: "oversized prompt",
        now: 10,
      })
      const completed = yield* turns.setStatus(created.id, "completed", undefined, 10)
      const childExecutionId = `child:${created.id}`
      const parent = delegationUnit(created.id, "nested-agent", childExecutionId, 2)
      if (parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
        return yield* Effect.die("missing nested parent tool")
      const parentId = parent.content.block.id
      const units: Array<Transcript.Unit> = [
        Transcript.empty(created.id, created.prompt).units[0]!,
        {
          key: `${created.id}:assistant:opening`,
          turnId: created.id,
          order: Transcript.unitOrder(`${created.id}:assistant:opening`, 1),
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "opening response" },
        },
        {
          key: `compaction:${created.id}`,
          turnId: created.id,
          order: Transcript.unitOrder(`compaction:${created.id}`, 1, 1),
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
        parent,
        ...Array.from(
          { length: 260 },
          (_, index): Transcript.Unit =>
            Transcript.attachUnit(
              {
                key: `${created.id}:assistant:${index.toString().padStart(3, "0")}`,
                turnId: childExecutionId,
                order: Transcript.unitOrder(`${created.id}:assistant:${index.toString().padStart(3, "0")}`, index),
                revision: index,
                content: {
                  _tag: "Block",
                  block: { _tag: "Notification", title: String(index), detail: "x".repeat(40_000) },
                },
              },
              parent,
              parentId,
              childExecutionId,
            ),
        ),
        {
          key: `${created.id}:assistant:final`,
          turnId: created.id,
          order: Transcript.unitOrder(`${created.id}:assistant:final`, 262),
          revision: 262,
          content: { _tag: "Entry", role: "assistant", text: "final response" },
        },
      ]
      yield* storeProjection(transcripts, completed, {
        ...Transcript.empty(created.id, created.prompt),
        units,
        revision: 262,
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const initial = yield* awaitSelectionLoaded(
        events,
        (event) =>
          event.oldestCursor !== undefined && event.entries.some((entry) => entry.unit.key === "turn:active:user"),
      )
      const loaded = initial.entries
      const cursor = initial.oldestCursor
      if (cursor === undefined) return yield* Effect.die("missing initial transcript cursor")
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(initial)
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(10 * 1024 * 1024)
      expect(loaded.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.filter((entry) => entry.unit.key === "turn:active:user")).toHaveLength(1)
      expect(loaded.some((entry) => entry.unit.key === `turn:${created.id}:user`)).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === `${created.id}:assistant:opening`)).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === `${created.id}:assistant:final`)).toBe(true)
      expect(loaded.filter((entry) => entry.unit.key === `compaction:${created.id}`)).toHaveLength(1)
      expect(cursor.orderKey).not.toBe(Transcript.encodeUnitOrder(Transcript.unitOrder(`turn:${created.id}:user`, 0)))

      const olderEntries: Array<TranscriptRepository.Entry> = []
      let hasOlder = initial.hasOlder
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
      const cursorEntry = loaded.find((entry) => Transcript.encodeUnitOrder(entry.unit.order) === cursor.orderKey)
      expect(Transcript.compareUnitOrder(olderEntries.at(-1)!.unit.order, cursorEntry!.unit.order)).toBeLessThan(0)
      const allEntries = [...olderEntries, ...loaded]
      expect(new Set(allEntries.map((entry) => entry.unit.key)).size).toBe(allEntries.length)
      expect(allEntries.filter((entry) => entry.unit.parentId === parentId)).toHaveLength(260)
      expect(hasOlder).toBe(false)
    }),
  )

  it.effect("keeps earlier conversation Turns when a cancelled Turn's child units outnumber the wire page", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* completeActive(turns, transcripts, 2)
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
        const childExecutionId = `child:${created.id}`
        const parent =
          entry.children === 0 ? undefined : delegationUnit(created.id, `delegate-${created.id}`, childExecutionId, 2)
        const units: Array<Transcript.Unit> = [
          Transcript.empty(created.id, entry.prompt).units[0]!,
          {
            key: `assistant:${created.id}:0`,
            turnId: created.id,
            order: Transcript.unitOrder(`assistant:${created.id}:0`, 1),
            revision: 1,
            content: { _tag: "Entry", role: "assistant", text: entry.reply },
          },
          ...(parent === undefined ? [] : [parent]),
          ...Array.from({ length: entry.children }, (_, child): Transcript.Unit => {
            if (parent === undefined || parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
              throw new TypeError(`Turn ${created.id} has no child parent tool`)
            return Transcript.attachUnit(
              {
                key: `${created.id}:child:${child.toString().padStart(3, "0")}`,
                turnId: childExecutionId,
                order: Transcript.unitOrder(`${created.id}:child:${child.toString().padStart(3, "0")}`, child),
                revision: child,
                content: { _tag: "Block", block: { _tag: "Reasoning", text: `child ${child}` } },
              },
              parent,
              parent.content.block.id,
              childExecutionId,
            )
          }),
        ]
        yield* storeProjection(transcripts, completed, {
          ...Transcript.empty(created.id, created.prompt),
          units,
          revision: units.length,
        })
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const expectedRootKeys = conversation.flatMap((entry) => [`turn:${entry.id}:user`, `assistant:${entry.id}:0`])
      const initial = yield* awaitSelectionLoaded(events, (event) => {
        const keys = new Set(event.entries.map((entry) => entry.unit.key))
        return expectedRootKeys.every((key) => keys.has(key))
      })
      const loaded = initial.entries
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
      expect(initial.hasOlder).toBe(true)
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
      const { session, turns, older } = yield* makeHarness(undefined, false, undefined, true)
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

const subagentRootEvents: ReadonlyArray<ExecutionBackend.Event> = serverEvents([
  {
    executionId: "execution:done",
    cursor: "done-started",
    sequence: 0,
    type: "execution.started",
    createdAt: 0,
  },
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
])

const subagentChildEvents: ReadonlyArray<ExecutionBackend.Event> = serverEvents([
  {
    executionId: subagentChildId,
    cursor: "childstarted~a0",
    sequence: 0,
    type: "execution.started",
    createdAt: 0,
  },
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
])

const makeSubagentReloadHarness = Effect.fn("InteractiveSessionTest.makeSubagentReloadHarness")(function* (options: {
  readonly storedTree: Transcript.Projection
  readonly turnLastCursor: string
  readonly childReplayEvents: ReadonlyArray<ExecutionBackend.Event>
  readonly consumed?: Readonly<
    Record<
      string,
      { readonly cursor: string; readonly sequence: number; readonly status?: "completed" | "failed" | "cancelled" }
    >
  >
  readonly turnStatus?: Turn.Status
  readonly followed?: Ref.Ref<ReadonlyArray<string>>
  readonly inspection?: (executionId: string) => ExecutionBackend.Inspection | undefined
  readonly replayEvents?: (executionId: string) => ReadonlyArray<ExecutionBackend.Event>
  readonly pageEvents?: (executionId: string, after: string | undefined) => ExecutionBackend.EventPage
  readonly projectionVersion?: number
}) {
  const subagentThread = thread("subagent-thread", 1)
  const doneTurn: Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
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
  const transcripts =
    options.projectionVersion === TranscriptRepository.invalidatedProjectionVersion
      ? yield* TranscriptRepository.makeMemory({
          initial: [invalidatedProjection(doneTurn, options.storedTree.revision)],
          turns,
        })
      : yield* TranscriptRepository.makeMemory({ turns })
  if (options.projectionVersion !== TranscriptRepository.invalidatedProjectionVersion)
    yield* storeProjection(transcripts, doneTurn, options.storedTree, {
      ...(options.consumed === undefined ? {} : { consumed: options.consumed }),
      ...(options.projectionVersion === undefined ? {} : { projectionVersion: options.projectionVersion }),
    })
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
  const eventsFor = (turnId: string): ReadonlyArray<ExecutionBackend.Event> => {
    const replay = options.replayEvents?.(turnId)
    if (replay !== undefined)
      return completeServerTimeline(replay).map((event) => Object.assign({}, event, { executionId: turnId }))
    if (turnId === "done")
      return completeServerTimeline(subagentRootEvents).map((event) =>
        Object.assign({}, event, { executionId: turnId }),
      )
    if (turnId === subagentChildId)
      return completeServerTimeline(options.childReplayEvents).map((event) =>
        Object.assign({}, event, { executionId: turnId }),
      )
    return []
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

interface ObservedProjectionStream {
  readonly turn: Turn.AgentExecutionTurn
  readonly streamId: string
  readonly patchRevision: number
  readonly state: Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptProjectionStarted" }>["state"]
  readonly units: ReadonlyMap<string, Transcript.Unit>
  readonly rootStatus?: "completed" | "failed" | "cancelled"
}

const observedProjectionEntries = (stream: ObservedProjectionStream): ReadonlyArray<TranscriptRepository.Entry> => {
  const turn = stream.rootStatus === undefined ? stream.turn : { ...stream.turn, status: stream.rootStatus }
  return [...stream.units.values()].map((unit) => ({
    turn,
    unit,
    projectionRevision: stream.state.revision,
    projectionModelPhase: stream.state.modelPhase,
  }))
}

const sortObservedEntries = (entries: ReadonlyArray<TranscriptRepository.Entry>) =>
  entries.toSorted(
    (left, right) =>
      left.turn.createdAt - right.turn.createdAt ||
      String(left.turn.id).localeCompare(String(right.turn.id)) ||
      Transcript.compareUnitOrder(left.unit.order, right.unit.order),
  )

const latestSelectionEntries = (events: ReadonlyArray<Operation.InteractiveEvent>) => {
  let entries: ReadonlyArray<TranscriptRepository.Entry> | undefined
  let selectionEpoch: number | undefined
  let threadId: string | undefined
  const streams = new Map<string, ObservedProjectionStream>()
  for (const event of events) {
    if (event._tag === "SelectionLoaded") {
      entries = event.entries
      selectionEpoch = event.selectionEpoch
      threadId = String(event.thread.id)
      streams.clear()
      continue
    }
    if (event._tag === "TranscriptProjectionStarted") {
      if (!Turn.isAgentExecution(event.turn)) continue
      if (
        selectionEpoch !== undefined &&
        (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId)
      )
        continue
      selectionEpoch = event.selectionEpoch
      threadId = String(event.threadId)
      streams.set(String(event.rootTurnId), {
        turn: event.turn,
        streamId: event.streamId,
        patchRevision: event.patchRevision,
        state: event.state,
        units: new Map(event.units.map((unit) => [unit.key, unit])),
        ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
      })
      continue
    }
    if (event._tag === "TranscriptProjectionPatched") {
      if (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId) continue
      const rootTurnId = String(event.rootTurnId)
      const current = streams.get(rootTurnId)
      if (
        current === undefined ||
        current.streamId !== event.streamId ||
        current.patchRevision !== event.baseRevision ||
        event.patchRevision !== event.baseRevision + 1
      )
        continue
      const units = new Map(current.units)
      for (const key of event.delta.remove) units.delete(key)
      for (const unit of event.delta.upsert) units.set(unit.key, unit)
      streams.set(rootTurnId, {
        ...current,
        patchRevision: event.patchRevision,
        state: event.state,
        units,
        ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
      })
      continue
    }
    if (event._tag === "TranscriptProjectionStopped") {
      if (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId) continue
      const rootTurnId = String(event.rootTurnId)
      const current = streams.get(rootTurnId)
      if (current === undefined || current.streamId !== event.streamId || current.patchRevision !== event.patchRevision)
        continue
      streams.set(rootTurnId, { ...current, rootStatus: event.status })
    }
  }
  if (entries === undefined && streams.size === 0) return undefined
  const roots = new Set(streams.keys())
  return sortObservedEntries([
    ...(entries ?? []).filter((entry) => !roots.has(String(entry.turn.id))),
    ...[...streams.values()].flatMap(observedProjectionEntries),
  ])
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

type SelectionLoadedEvent = Extract<Operation.InteractiveEvent, { readonly _tag: "SelectionLoaded" }>
type TranscriptPagePrependedEvent = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptPagePrepended" }>

const awaitSelectionLoaded = (
  events: ReadonlyArray<Operation.InteractiveEvent>,
  until: (event: SelectionLoadedEvent) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const event = events.findLast(
        (candidate): candidate is SelectionLoadedEvent => candidate._tag === "SelectionLoaded" && until(candidate),
      )
      if (event !== undefined) return event
      yield* Effect.yieldNow
    }
    const detail = events.map((event) => {
      if (event._tag === "SelectionLoaded")
        return {
          tag: event._tag,
          entries: event.entries.map((entry) => entry.unit.key),
          hasOlder: event.hasOlder,
          oldestCursor: event.oldestCursor,
        }
      if (event._tag === "ExecutionFailed") return { tag: event._tag, message: event.message }
      return { tag: event._tag }
    })
    const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(detail).pipe(Effect.orDie)
    return yield* Effect.die(`selection did not load the expected transcript page: ${encoded}`)
  })

const awaitPrependedPage = (events: ReadonlyArray<Operation.InteractiveEvent>, previousCount: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const pages = events.filter(
        (event): event is TranscriptPagePrependedEvent => event._tag === "TranscriptPagePrepended",
      )
      if (pages.length > previousCount) return pages.at(-1)!
      yield* Effect.yieldNow
    }
    return yield* Effect.die("older transcript page did not load")
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
  it.effect("refolds terminal child outcomes from Relay after a projection-version change", () =>
    Effect.gen(function* () {
      const failedRootEvents: ReadonlyArray<ExecutionBackend.Event> = [
        ...subagentRootEvents.slice(0, 3),
        {
          executionId: "execution:done",
          cursor: "failed-root",
          sequence: 3,
          type: "execution.failed",
          createdAt: 5,
          text: "root failed after delegation",
        },
      ]
      const failedRoot = Transcript.project("done", "delegate", failedRootEvents)
      const completedChild = Transcript.project(subagentChildId, "", subagentChildEvents)
      const storedTree = Transcript.withNestedProjections(failedRoot, [
        { parentId: subagentToolId, projection: completedChild },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "failed-root",
        childReplayEvents: subagentChildEvents,
        turnStatus: "failed",
        replayEvents: (executionId) => (executionId === "done" ? failedRootEvents : subagentChildEvents),
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
      })

      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id)
      for (
        let attempt = 0;
        attempt < 400 &&
        !events.some(
          (event) =>
            event._tag === "ThreadUsageUpdated" && event.cost._tag === "Available" && event.tokens._tag === "Available",
        );
        attempt += 1
      )
        yield* Effect.yieldNow
      const root = entries.filter((entry) => entry.turn.id === "done" && entry.unit.parentId === undefined)
      const tools = root.flatMap((entry) =>
        entry.unit.content._tag === "Block" && entry.unit.content.block._tag === "ToolCall"
          ? [entry.unit.content.block]
          : [],
      )

      expect(
        root.every(
          (entry) =>
            Turn.isAgentExecution(entry.turn) &&
            entry.turn.status === "failed" &&
            entry.turn.lastCursor === "root-failed",
        ),
      ).toBe(true)
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
            entry.unit.content.block.id === Transcript.scopedIdentity(completedChildId, "nested"),
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
      expect(events.findLast((event) => event._tag === "ThreadUsageUpdated")).toMatchObject({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 1,
        threadId: "subagent-thread",
        cost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0 },
        tokens: { _tag: "Available", total: 30, uncountedAttempts: 0 },
        time: { _tag: "Available" },
      })
    }),
  )

  it.effect("renders an already-completed child from persisted units after following it once", () =>
    Effect.gen(function* () {
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const rootProjection = Transcript.project("done", "delegate", subagentRootEvents.slice(0, 3))
      const storedTree = Transcript.withNestedProjections(rootProjection, [
        { parentId: subagentToolId, projection: Transcript.empty(subagentChildId, "") },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: subagentRootEvents[2]!.cursor,
        replayEvents: (executionId) => (executionId === "done" ? subagentRootEvents.slice(0, 3) : subagentChildEvents),
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
        {
          executionId: nestedId,
          cursor: "nested-started",
          sequence: 0,
          type: "execution.started",
          createdAt: 4,
          timestampSource: "server",
        },
      ]
      const failedRootEvents: ReadonlyArray<ExecutionBackend.Event> = [
        ...subagentRootEvents.slice(0, 3),
        {
          executionId: "execution:done",
          cursor: "root-failed",
          sequence: 3,
          type: "execution.failed",
          createdAt: 6,
          text: "root failed after its descendants finished",
        },
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
      const rootProjection = Transcript.project("done", "delegate", failedRootEvents)
      const storedTree = Transcript.withNestedProjections(rootProjection, [
        { parentId: subagentToolId, projection: Transcript.empty(subagentChildId, "") },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "root-failed",
        childReplayEvents: childEvents,
        consumed: {
          done: { cursor: "root-failed", sequence: 3, status: "failed" },
          [Transcript.executionKey(subagentChildId)]: { cursor: "", sequence: -1 },
        },
        turnStatus: "failed",
        followed,
        inspection,
        replayEvents: (executionId) => {
          if (executionId === "done") return failedRootEvents
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
        !events.some(
          (event) =>
            event._tag === "TranscriptProjectionPatched" &&
            event.origin._tag === "Event" &&
            event.origin.cursor === "nested-complete",
        );
        attempt += 1
      )
        yield* Effect.yieldNow

      expect(yield* Ref.get(followed)).toContain(nestedId)
      expect(events.some((event) => event._tag === "TranscriptProjectionFailed")).toBe(false)
    }),
  )

  it.effect("resumes an exact empty child checkpoint from its durable event suffix", () =>
    Effect.gen(function* () {
      const rootProjection = Transcript.project("done", "delegate", subagentRootEvents)
      const brokenTree = Transcript.withNestedProjections(rootProjection, [
        { parentId: subagentToolId, projection: Transcript.empty(subagentChildId, "") },
      ])
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: { ...brokenTree, pricingVersion: Transcript.pricingVersion },
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        consumed: {
          done: { cursor: "done-final", sequence: 5, status: "completed" },
          [Transcript.executionKey(subagentChildId)]: { cursor: "", sequence: -1 },
        },
      })
      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      expect(events.filter((event) => event._tag === "SelectionLoaded")).toHaveLength(1)
      expect(events.some((event) => event._tag === "TranscriptProjectionFailed")).toBe(false)
      for (
        let attempt = 0;
        attempt < 400 &&
        (yield* transcripts.get(Turn.TurnId.make("done")))?.executionCheckpoints.find(
          (checkpoint) => checkpoint.executionKey === Transcript.executionKey(subagentChildId),
        )?.cursor !== "childdone~a4";
        attempt += 1
      )
        yield* Effect.yieldNow
      expect(
        (yield* transcripts.get(Turn.TurnId.make("done")))?.executionCheckpoints.find(
          (checkpoint) => checkpoint.executionKey === Transcript.executionKey(subagentChildId),
        ),
      ).toMatchObject({ cursor: "childdone~a4", status: "completed" })
      expect(
        entries.filter(
          (entry) =>
            entry.unit.turnId === subagentChildId &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.name === "bash",
        ),
      ).toHaveLength(1)
      expect(
        entries.filter(
          (entry) =>
            entry.unit.turnId === subagentChildId &&
            entry.unit.content._tag === "Entry" &&
            entry.unit.content.role === "assistant" &&
            entry.unit.content.text.includes("All tests pass."),
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("does not promote a refold when a terminal child exposes no durable events", () =>
    Effect.gen(function* () {
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: [],
        followed,
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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
      expect(stored?.projectionVersion).toBe(TranscriptRepository.invalidatedProjectionVersion)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === subagentChildId)).toBeUndefined()
      const failedFollows = yield* Ref.get(followed)

      yield* session.reopenThread(2)
      for (let attempt = 0; attempt < 200; attempt += 1) yield* Effect.yieldNow
      expect((yield* Ref.get(followed)).length).toBeGreaterThan(failedFollows.length)
    }),
  )

  it.effect("keeps an invalidated projection empty when Relay cannot refold its child", () =>
    Effect.gen(function* () {
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-later",
        childReplayEvents: [],
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
      })
      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(TranscriptRepository.invalidatedProjectionVersion)
      expect(stored?.units).toEqual([])
      expect(stored?.executionCheckpoints).toEqual([])
    }),
  )

  it.effect("does not replay a refolded terminal child tree when the thread reopens", () =>
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
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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
      expect(inspections).toBe(repairedInspections)
      expect(eventPages).toBe(repairedPages)
    }),
  )

  it.effect("does not promote an invalidated projection while Relay reports active execution", () =>
    Effect.gen(function* () {
      let inspections = 0
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: [],
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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

      const { events } = yield* selectionEntriesFor(session, subagentThread.id)
      for (
        let attempt = 0;
        attempt < 400 && !events.some((event) => event._tag === "TranscriptProjectionFailed");
        attempt += 1
      )
        yield* Effect.yieldNow
      expect((yield* transcripts.get(Turn.TurnId.make("done")))?.projectionVersion).toBe(
        TranscriptRepository.invalidatedProjectionVersion,
      )
      expect(events.some((event) => event._tag === "TranscriptProjectionFailed")).toBe(true)
      const firstInspections = inspections
      yield* session.reopenThread(2)
      expect(inspections).toBe(firstInspections)
    }),
  )

  it.effect("leaves a descendant unconsumed until Relay can read it", () =>
    Effect.gen(function* () {
      let childAvailable = false
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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
      expect(unreadable?.projectionVersion).toBe(TranscriptRepository.invalidatedProjectionVersion)
      expect(
        unreadable?.executionCheckpoints.find((entry) => entry.executionKey === subagentChildId)?.status,
      ).toBeUndefined()

      childAvailable = true
      yield* session.reopenThread(2)
      for (
        let attempt = 0;
        attempt < 400 &&
        (yield* transcripts.get(Turn.TurnId.make("done")))?.projectionVersion !== ExecutionIngest.projectionVersion;
        attempt += 1
      )
        yield* Effect.yieldNow
      const readable = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(readable?.executionCheckpoints.find((entry) => entry.executionKey === subagentChildId)?.status).toBe(
        "completed",
      )
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

  it.effect("rejects an inspection-only child that has no durable parent attachment", () =>
    Effect.gen(function* () {
      const lateChild = `${subagentChildId}:late`
      let rootInspections = 0
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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
      for (
        let attempt = 0;
        attempt < 400 &&
        (yield* transcripts.get(Turn.TurnId.make("done")))?.projectionVersion !== ExecutionIngest.projectionVersion;
        attempt += 1
      )
        yield* Effect.yieldNow
      expect(rootInspections).toBeGreaterThan(1)
      const stored = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === lateChild)).toBeUndefined()
    }),
  )

  it.effect("refolds only durable root and child events and excludes stale stored children", () =>
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
      const staleTree = Transcript.withNestedProjections(
        Transcript.project("done", "wrong stored prompt", subagentRootEvents),
        [{ parentId: subagentToolId, projection: staleChild }],
      )
      const staleParent = staleTree.units.find(
        (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
      )!
      const storedTree = {
        ...staleTree,
        units: staleTree.units.concat(
          orphan.units.map((unit) => Transcript.attachUnit(unit, staleParent, "orphan-parent", "orphan-child")),
        ),
      }
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
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
      expect(stored?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "delegate")).toBe(true)
      expect(
        stored?.units.some(
          (unit) =>
            unit.content._tag === "Entry" && ["stale stored child", "orphan stored child"].includes(unit.content.text),
        ),
      ).toBe(false)
    }),
  )

  it.effect("does not promote a refold when Relay cannot replay the root", () =>
    Effect.gen(function* () {
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: Transcript.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
        replayEvents: (executionId) => (executionId === subagentChildId ? subagentChildEvents : []),
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(TranscriptRepository.invalidatedProjectionVersion)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === "done")).toBeUndefined()
    }),
  )
})

const spendThread = thread("spend-thread", 1)
const spendTurnId = Turn.TurnId.make("spend-turn")
const spendExecutionId = String(spendTurnId)

const stamped = (
  cursor: string,
  type: ExecutionBackend.Event["type"],
  createdAt: number,
  sequence: number,
  fields: Record<string, unknown> = {},
): ExecutionBackend.Event =>
  ({
    executionId: spendExecutionId,
    cursor,
    sequence,
    type,
    createdAt,
    timestampSource: "server",
    ...fields,
  }) as ExecutionBackend.Event

const spendEvents: ReadonlyArray<ExecutionBackend.Event> = [
  stamped("spend-started", "execution.started", 10_000, 1),
  stamped("spend-usage", "model.attempt.completed", 20_000, 2, {
    data: { model_attempt_id: "spend-attempt", attempt: 1, cost: { amount: 0.75, currency: "USD" } },
  }),
  stamped("spend-answer", "model.output.completed", 30_000, 3, { text: "spent" }),
]

const spendCompleted = stamped("spend-completed", "execution.completed", 40_000, 4)

const spendTimeline: ReadonlyArray<ExecutionBackend.Event> = [...spendEvents, spendCompleted]

const legacyUsageRow = () => {
  const folded = UsageCost.foldBatch(
    UsageCost.empty,
    spendTimeline.map((event) => ({
      threadId: String(spendThread.id),
      turnId: String(spendTurnId),
      event,
    })),
    new Set([spendExecutionId]),
  )
  if (Result.isFailure(folded)) throw folded.failure
  const snapshot = folded.success
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
  const spendTurn: Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
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
    ...(options.turnStatus === undefined ? {} : { lastCursor: "spend-completed" }),
  }
  const repositories = yield* ThreadRepository.makeMemory([spendThread])
  const turns = yield* TurnRepository.makeMemory([spendTurn])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const transcripts =
    options.legacy === true
      ? yield* TranscriptRepository.makeMemory({
          initial: [
            invalidatedProjection(
              spendTurn,
              Transcript.project(String(spendTurnId), spendTurn.prompt, spendTimeline).revision,
            ),
          ],
          turns,
        })
      : yield* TranscriptRepository.makeMemory({ turns })
  const follows = yield* Ref.make(0)
  const blocked = yield* Ref.make(0)
  const legacy = options.legacy === true ? legacyUsageRow() : undefined
  const usage = yield* UsageRepository.makeMemory({
    initial:
      legacy === undefined
        ? []
        : [
            {
              sourceId: String(spendTurnId),
              turnId: String(spendTurnId),
              threadId: String(spendThread.id),
              revision: 1,
              projectionVersion: UsageRepository.projectionVersion - 1,
              foldJson: legacy.foldJson,
              ...legacy.totals,
            },
          ],
  })
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
    inspect: (turnId) => {
      if (String(turnId) !== String(spendTurnId)) return Effect.void.pipe(Effect.as(undefined))
      if (options.turnStatus === undefined) {
        return Effect.succeed({ ...terminal, status: "running" as const, lastCursor: "spend-answer" })
      }
      return Effect.succeed({ ...terminal, lastCursor: "spend-completed" })
    },
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

  it.effect("holds the displayed total when the persisted projection is reselected", () =>
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
      for (let attempt = 0; attempt < 10; attempt += 1) yield* settle

      const updates = events.flatMap((event) => (event._tag === "ThreadUsageUpdated" ? [event] : []))
      const shown = updates.flatMap((event) => (event.cost._tag === "Available" ? [event.cost.usd] : []))

      expect(events.some((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 2)).toBe(true)
      const reselectedOrigins = events.flatMap((event) =>
        event._tag === "TranscriptProjectionPatched" && event.selectionEpoch === 2 && event.origin._tag === "Event"
          ? [`${event.origin.executionId}:${event.origin.cursor}:${event.origin.type}`]
          : [],
      )
      expect(new Set(reselectedOrigins).size).toBe(reselectedOrigins.length)
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
        TranscriptRepository.invalidatedProjectionVersion,
      )
      expect((yield* transcripts.get(spendTurnId))?.executionCheckpoints).toEqual([])
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
      expect(
        refolded?.executionCheckpoints.find(
          (entry) => entry.executionKey === Transcript.executionKey(String(spendTurnId)),
        )?.status,
      ).toBe("completed")
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
