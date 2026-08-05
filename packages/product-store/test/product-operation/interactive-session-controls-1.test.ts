import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { createTurn } from "../support/product-test-current-state"
import { productLayer, collectEvents, waitForSessions, serverEvents } from "./interactive-session-base-support"
import { makeHarness } from "./interactive-session-harness-support"

describe("InteractiveSession controls", () => {
  it.effect("publishes live thread summaries and clears unread state when a thread is selected", () =>
    Effect.gen(function* () {
      const { session, older } = yield* makeHarness()
      const events = yield* Queue.unbounded<InteractiveEvent>()
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
      const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory()
      const turns = yield* RuntimeFixtures.TurnRepository.makeMemory()
      const sessions = new Map<string, InteractiveSession>()
      const toolWorkspaces: Array<string> = []
      const threadSequence = yield* Ref.make(0)
      const turnSequence = yield* Ref.make(0)
      const backend = RuntimeFixtures.ExecutionGateway.Service.of({
        startTurn: (input) =>
          Effect.succeed({ runId: "workspace-session-run", turnId: input.turnId, threadId: input.threadId }),
        cancelTurn: () => Effect.die("unused"),
        steerTurn: () => Effect.die("unused"),
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" }),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
        backendLayer: Layer.succeed(RuntimeFixtures.ExecutionGateway.Service, backend),
        toolRuntimeLayer: (workspace) => {
          toolWorkspaces.push(workspace)
          return RuntimeFixtures.ToolRuntime.testLayer(() => Effect.succeed({ text: workspace, truncated: false }))
        },
        defaultWorkspace: "/default",
        makeThreadId: Ref.updateAndGet(threadSequence, (value) => value + 1).pipe(
          Effect.map((value) => RuntimeFixtures.Thread.ThreadId.make(`thread-${value}`)),
        ),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => RuntimeFixtures.Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: (input, session) =>
          Effect.sync(() => sessions.set(input.workspace ?? "/default", session)).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Service)
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
      const alphaEvents: Array<InteractiveEvent> = []
      const betaEvents: Array<InteractiveEvent> = []
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
      expect((yield* repositories.get(RuntimeFixtures.Thread.ThreadId.make(alphaThreadId!)))?.workspace).toBe("/alpha")
      expect((yield* repositories.get(RuntimeFixtures.Thread.ThreadId.make(betaThreadId!)))?.workspace).toBe("/beta")
      expect(
        (yield* turns.list(RuntimeFixtures.Thread.ThreadId.make(alphaThreadId!))).map((turn) => turn.prompt),
      ).toEqual(["alpha prompt", "alpha follow-up"])
      expect(
        (yield* turns.list(RuntimeFixtures.Thread.ThreadId.make(betaThreadId!))).map((turn) => turn.prompt),
      ).toEqual(["beta prompt", "beta follow-up"])
      expect(toolWorkspaces.toSorted()).toEqual(["/alpha", "/beta"])
    }),
  )

  it.effect("submits a prompt through every returned session callback", () =>
    Effect.gen(function* () {
      const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory()
      const turns = yield* RuntimeFixtures.TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const submittedBackend = RuntimeFixtures.ExecutionGateway.Service.of({
        startTurn: (input) =>
          Effect.succeed({ runId: `${input.turnId}-run`, turnId: input.turnId, threadId: input.threadId }),
        cancelTurn: () => Effect.die("unused"),
        steerTurn: () => Effect.die("unused"),
        watchTurn: (link) =>
          Stream.fromIterable(
            serverEvents([
              {
                executionId: link.runId,
                cursor: "started",
                sequence: 0,
                type: "execution.started",
                createdAt: 0,
              },
              {
                executionId: link.runId,
                cursor: "output",
                sequence: 1,
                type: "model.output.completed",
                createdAt: 1,
              },
              {
                executionId: link.runId,
                cursor: "done",
                sequence: 2,
                type: "execution.completed",
                createdAt: 2,
              },
            ]),
          ),
        inspectTurn: () => Effect.succeed({ status: "completed" }),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
        backendLayer: Layer.succeed(RuntimeFixtures.ExecutionGateway.Service, submittedBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(RuntimeFixtures.Thread.ThreadId.make("created")),
        makeTurnId: Effect.succeed(RuntimeFixtures.Turn.TurnId.make("created-turn")),
        interactive: (_, session) =>
          Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.reopenThread(1)
      yield* session.submit("")
      while ((yield* turns.get(RuntimeFixtures.Turn.TurnId.make("created-turn")))?.status !== "completed")
        yield* Effect.yieldNow
      while (!events.some((event) => event._tag === "TranscriptProjectionStopped")) yield* Effect.yieldNow
      expect(
        events.filter(
          (event) =>
            event._tag !== "ThreadsListed" &&
            event._tag !== "TranscriptProjectionStarted" &&
            event._tag !== "TranscriptProjectionStopped" &&
            event._tag !== "TurnSettled",
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
            executionId: "created-turn-run",
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
            executionId: "created-turn-run",
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
            executionId: "created-turn-run",
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
        },
      ])
      expect(yield* repositories.get(RuntimeFixtures.Thread.ThreadId.make("created"))).toMatchObject({
        title: "New thread",
      })
      expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("created-turn"))).toMatchObject({
        status: "completed",
      })
    }),
  )

  it.effect("admits, edits, and dequeues pending turns while the active turn is still executing", () =>
    Effect.gen(function* () {
      const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory()
      const turns = yield* RuntimeFixtures.TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const nextTurn = yield* Ref.make(0)
      const activeStarted = yield* Deferred.make<void>()
      const activeSubmitted = yield* Deferred.make<void>()
      const releaseActive = yield* Deferred.make<void>()
      const pendingStarted = yield* Deferred.make<void>()
      const backend = RuntimeFixtures.ExecutionGateway.Service.of({
        startTurn: (input) =>
          input.turnId === "turn-0"
            ? Deferred.succeed(activeStarted, undefined).pipe(
                Effect.as({ runId: "active-queue-run", turnId: input.turnId, threadId: input.threadId }),
              )
            : Deferred.succeed(pendingStarted, undefined).pipe(
                Effect.as({ runId: "promoted-queue-run", turnId: input.turnId, threadId: input.threadId }),
              ),
        cancelTurn: () => Effect.die("unused"),
        steerTurn: () => Effect.die("unused"),
        watchTurn: (link) =>
          link.turnId === "turn-0"
            ? Stream.fromEffect(Deferred.await(releaseActive)).pipe(
                Stream.map(() => ({
                  executionId: link.runId,
                  cursor: "active-completed",
                  sequence: 0,
                  type: "execution.completed" as const,
                  timestampSource: "baton" as const,
                  createdAt: 1,
                })),
              )
            : Stream.succeed({
                executionId: link.runId,
                cursor: "promoted-completed",
                sequence: 0,
                type: "execution.completed" as const,
                timestampSource: "baton" as const,
                createdAt: 2,
              }),
        inspectTurn: () => Effect.succeed({ status: "running" }),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
        backendLayer: Layer.succeed(RuntimeFixtures.ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 2,
        makeThreadId: Effect.succeed(RuntimeFixtures.Thread.ThreadId.make("thread")),
        makeTurnId: Ref.getAndUpdate(nextTurn, (value) => value + 1).pipe(
          Effect.map((value) => RuntimeFixtures.Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: (_, session) =>
          Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<InteractiveEvent> = []
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

      expect(yield* turns.readQueue(RuntimeFixtures.Thread.ThreadId.make("thread"))).toMatchObject({
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
      expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("turn-3"))).toBeUndefined()
      yield* session.editQueued("turn-1", "edited")
      yield* session.dequeue("turn-2")
      expect(yield* turns.readQueue(RuntimeFixtures.Thread.ThreadId.make("thread"))).toMatchObject({
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
      expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("turn-1"))).toMatchObject({ status: "completed" })
      expect(events.filter((event) => event._tag === "TurnStarted").map((event) => event.turn.id)).toEqual([
        "turn-0",
        "turn-1",
      ])
    }),
  )

  it.effect("edits and dequeues queued turns and reports the remaining queue", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* createTurn(turns, {
        id: RuntimeFixtures.Turn.TurnId.make("queued"),
        threadId: older.id,
        prompt: "before",
        now: 2,
      })
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 2)
      yield* session.editQueued("queued", "after")
      yield* Effect.yieldNow
      expect((yield* turns.get(RuntimeFixtures.Turn.TurnId.make("queued")))?.prompt).toBe("after")
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
      expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("queued"))).toBeUndefined()
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
})
