import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import { Context, Deferred, Effect, Fiber, Layer, Ref, Result } from "effect"
import { createTurn } from "../support/product-test-current-state"
import { productLayer, collectEvents, waitForSessions, active, serverEvents } from "./interactive-session-base-support"
import { makeHarness } from "./interactive-session-harness-support"
import { awaitSelectionLoaded } from "./interactive-session-selection-support"

describe("InteractiveSession controls", () => {
  it.effect("steers and cancels the selected active turn", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const events: Array<InteractiveEvent> = []
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
      expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("active"))).toMatchObject({
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

  it.effect("quit materializes a durable user transcript before the turn is cancelled", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts } = yield* makeHarness()
      expect(yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("active"))).toBeUndefined()
      yield* session.quit
      expect((yield* turns.get(RuntimeFixtures.Turn.TurnId.make("active")))?.status).toBe("cancelled")
      const projection = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("active"))
      expect(projection?.units.some((unit) => unit.key === "turn:active:user")).toBe(true)
    }),
  )

  it.effect("selects a cancelled turn without durable projection using the prompt seed", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* turns.requestStop(RuntimeFixtures.Turn.TurnId.make("active"), 2)
      yield* turns.setStatus(RuntimeFixtures.Turn.TurnId.make("active"), "cancelled", "cancel-cursor", 3)
      expect(yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("active"))).toBeUndefined()
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const loaded = yield* awaitSelectionLoaded(events, (event) =>
        event.entries.some((entry) => entry.unit.key === "turn:active:user"),
      )
      expect(loaded.entries.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.entries.find((entry) => entry.unit.key === "turn:active:user")?.turn.prompt).toBe("active prompt")
    }),
  )

  it.effect("quit mid-flight then reopen keeps the user prompt and prices only provider USD", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* session.quit
      expect((yield* turns.get(RuntimeFixtures.Turn.TurnId.make("active")))?.status).toBe("cancelled")
      expect(
        (yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("active")))?.units.some(
          (unit) => unit.key === "turn:active:user",
        ),
      ).toBe(true)
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const loaded = yield* awaitSelectionLoaded(events, (event) =>
        event.entries.some((entry) => entry.unit.key === "turn:active:user"),
      )
      expect(loaded.entries.find((entry) => entry.unit.key === "turn:active:user")?.turn.prompt).toBe("active prompt")
      const tokensOnly = TranscriptFixtures.UsageCost.observe(TranscriptFixtures.UsageCost.empty, {
        threadId: String(older.id),
        turnId: "active",
        event: {
          executionId: "active",
          cursor: "usage-only",
          sequence: 1,
          type: "model.usage.reported",
          createdAt: 1,
          data: {
            model_attempt_id: "attempt-1",
            provider: "openai",
            model: "gpt-5.6-sol",
            input_tokens: 1_000,
            input_tokens_uncached: 1_000,
            input_tokens_cache_read: 0,
            input_tokens_cache_write: 0,
            output_tokens: 100,
          },
        },
      })
      if (Result.isFailure(tokensOnly)) return yield* Effect.die(tokensOnly.failure)
      expect(tokensOnly.success.global.costUsd).toBe(0)
      expect(tokensOnly.success.global.tokens).toBe(1_100)
      const priced = TranscriptFixtures.UsageCost.observe(tokensOnly.success, {
        threadId: String(older.id),
        turnId: "active",
        event: {
          executionId: "active",
          cursor: "attempt-completed",
          sequence: 2,
          type: "model.attempt.completed",
          createdAt: 2,
          data: {
            model_attempt_id: "attempt-1",
            attempt: 1,
            cost: { amount: 1.5, currency: "USD" },
          },
        },
      })
      if (Result.isFailure(priced)) return yield* Effect.die(priced.failure)
      expect(priced.success.global).toMatchObject({ costUsd: 1.5, tokens: 1_100, unpricedAttempts: 0 })
    }),
  )

  it.effect("persists interrupt-and-send before cancelling the active turn", () =>
    Effect.gen(function* () {
      const { turns, controls, older } = yield* makeHarness()
      const persistedAtCancel = yield* Ref.make<RuntimeFixtures.Turn.Turn | undefined>(undefined)
      const checkingBackend = RuntimeFixtures.ExecutionBackend.Service.of({
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
          turns.get(RuntimeFixtures.Turn.TurnId.make(turnId)).pipe(
            Effect.orDie,
            Effect.map((turn) =>
              turn === undefined
                ? undefined
                : { turnId, status: turn.status, waits: [], pendingTools: [], children: [] },
            ),
          ),
        steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
        cancel: (turnId) =>
          turns.get(RuntimeFixtures.Turn.TurnId.make("pending")).pipe(
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
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const layer = productLayer({
        repositoryLayer: RuntimeFixtures.ThreadRepository.memoryLayer([older]),
        turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
        backendLayer: Layer.succeed(RuntimeFixtures.ExecutionBackend.Service, checkingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.succeed(RuntimeFixtures.Turn.TurnId.make("pending")),
        interactive: (_, value) =>
          Ref.update(sessions, (values) => [...values, value]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const checkingSession = (yield* Ref.get(sessions))[0]
      if (checkingSession === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<InteractiveEvent> = []
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
      expect((yield* turns.get(RuntimeFixtures.Turn.TurnId.make("active")))?.status).toBe("cancelled")
      expect(cancellationProjected()).toBe(true)
      expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("pending"))).toMatchObject({
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
      const finalTurnId = RuntimeFixtures.Turn.TurnId.make("promoted-three")
      const { session, turns, controls, older } = yield* makeHarness(undefined, false, undefined, false, false, {
        release,
        finished,
        finalTurnId,
      })
      const events: Array<InteractiveEvent> = []
      yield* turns.setStatus(RuntimeFixtures.Turn.TurnId.make("active"), "waiting", "wait-cursor", 2)
      for (const [index, id] of ["promoted-one", "promoted-two", "promoted-three"].entries())
        yield* createTurn(turns, {
          id: RuntimeFixtures.Turn.TurnId.make(id),
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
        const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory()
        const turns = yield* RuntimeFixtures.TurnRepository.makeMemory()
        const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
        const commands = yield* Ref.make<ReadonlyArray<string>>([])
        let turnNumber = 0
        const layer = productLayer({
          repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
          turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
          backendLayer: Layer.succeed(
            RuntimeFixtures.ExecutionBackend.Service,
            RuntimeFixtures.ExecutionBackend.Service.of({
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
            RuntimeFixtures.ToolRuntime.testLayer((request) => {
              const command = request._tag === "Shell" ? request.args.join(" ") : request._tag
              return Ref.update(commands, (values) => [...values, command]).pipe(
                Effect.as({ text: `output:${command}`, truncated: false, exitCode: 0 }),
              )
            }),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(RuntimeFixtures.Thread.ThreadId.make("shell-thread")),
          makeTurnId: Effect.sync(() => RuntimeFixtures.Turn.TurnId.make(`shell-turn-${turnNumber++}`)),
          interactive: (_, session) =>
            Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
        })
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Service)
        yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false, workspace: "/client-shell" }),
        )
        yield* waitForSessions(sessions)
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("Missing interactive session")
        const allEvents: Array<InteractiveEvent> = []
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
        expect((yield* turns.list(RuntimeFixtures.Thread.ThreadId.make("shell-thread")))[0]).toMatchObject({
          _tag: "RecordedShell",
          prompt: "$ printf persisted",
          status: "completed",
          result: { text: "output:-lc printf persisted", truncated: false, exitCode: 0 },
        })

        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted"])

        const beforeIncognito = (yield* turns.list(RuntimeFixtures.Thread.ThreadId.make("shell-thread"))).length
        const incognito = yield* runShell("printf secret", true)
        expect(incognito.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: true })
        expect((yield* turns.list(RuntimeFixtures.Thread.ThreadId.make("shell-thread"))).length).toBe(beforeIncognito)
        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted", "-lc printf secret"])

        yield* turns.copy(
          {
            ...active(RuntimeFixtures.Thread.ThreadId.make("shell-thread"), "active-shell-blocker"),
            prompt: "active",
            createdAt: 2,
            updatedAt: 2,
          },
          128,
        )
        const concurrentStart = allEvents.length
        yield* session.shell(RuntimeFixtures.Thread.ThreadId.make("shell-thread"), "printf alongside", false)
        while (!allEvents.slice(concurrentStart).some((event) => event._tag === "ShellCompleted"))
          yield* Effect.yieldNow
        const concurrent = allEvents.slice(concurrentStart)
        expect(concurrent.some((event) => event._tag === "QueueUpdated")).toBe(false)
        expect(
          (yield* turns.list(RuntimeFixtures.Thread.ThreadId.make("shell-thread"))).find(
            (turn) =>
              RuntimeFixtures.ThreadResult.TurnResult.isRecordedShell(turn) && turn.command === "printf alongside",
          ),
        ).toMatchObject({
          _tag: "RecordedShell",
          status: "completed",
          result: { text: "output:-lc printf alongside", exitCode: 0 },
        })
        expect(yield* turns.get(RuntimeFixtures.Turn.TurnId.make("active-shell-blocker"))).toMatchObject({
          status: "running",
        })
      }),
  )
})
