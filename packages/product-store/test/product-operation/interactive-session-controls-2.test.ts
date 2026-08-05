import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Context, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { createTurn } from "../support/product-test-current-state"
import {
  productLayer,
  collectEvents,
  waitForSessions,
  active,
  serverEvents,
  thread,
} from "./interactive-session-base-support"
import { makeHarness } from "./interactive-session-harness-support"

describe("InteractiveSession controls", () => {
  it.effect("persists interrupt-and-send before cancelling the active turn", () =>
    Effect.gen(function* () {
      const older = thread("older", 1)
      const turns = yield* RuntimeFixtures.TurnRepository.makeMemory([active(older.id)])
      const persistedAtCancel = yield* Ref.make<RuntimeFixtures.Turn.Turn | undefined>(undefined)
      const activeCancelled = yield* Deferred.make<void>()
      const checkingBackend = RuntimeFixtures.ExecutionGateway.Service.of({
        startTurn: (input) =>
          Effect.succeed({ runId: `${input.turnId}-run`, turnId: input.turnId, threadId: input.threadId }),
        watchTurn: (link) =>
          link.turnId === "active"
            ? Stream.fromEffect(Deferred.await(activeCancelled)).pipe(
                Stream.map(() => ({
                  executionId: link.runId,
                  cursor: "active-cancelled",
                  sequence: 0,
                  type: "execution.cancelled" as const,
                  timestampSource: "baton" as const,
                  createdAt: 2,
                })),
              )
            : Stream.fromIterable(
                serverEvents([
                  {
                    executionId: link.runId,
                    cursor: "replacement-started",
                    sequence: 0,
                    type: "execution.started",
                    createdAt: 3,
                  },
                  {
                    executionId: link.runId,
                    cursor: "replacement-done",
                    sequence: 1,
                    type: "execution.completed",
                    createdAt: 4,
                  },
                ]),
              ),
        inspectTurn: (link) =>
          turns.get(RuntimeFixtures.Turn.TurnId.make(link.turnId)).pipe(
            Effect.orDie,
            Effect.map((turn) => ({ status: turn?.status ?? ("unavailable" as const) })),
          ),
        steerTurn: () => Effect.void,
        cancelTurn: () =>
          turns.get(RuntimeFixtures.Turn.TurnId.make("pending")).pipe(
            Effect.orDie,
            Effect.flatMap((pending) => Ref.set(persistedAtCancel, pending)),
            Effect.andThen(Deferred.succeed(activeCancelled, undefined)),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const layer = productLayer({
        repositoryLayer: RuntimeFixtures.ThreadRepository.memoryLayer([older]),
        turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
        backendLayer: Layer.succeed(RuntimeFixtures.ExecutionGateway.Service, checkingBackend),
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
      yield* checkingSession.selectThread(older.id, 1)
      yield* checkingSession.interruptAndSend("next prompt")
      expect(yield* Ref.get(persistedAtCancel)).toMatchObject({ prompt: "next prompt", status: "queued" })
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
      yield* turns.setStatus(RuntimeFixtures.Turn.TurnId.make("active"), "waiting", 2)
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
      expect(calls.filter((call) => call[0] === "startTurn")).toEqual([
        ["startTurn", "promoted-one"],
        ["startTurn", "promoted-two"],
        ["startTurn", "promoted-three"],
      ])
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
            RuntimeFixtures.ExecutionGateway.Service,
            RuntimeFixtures.ExecutionGateway.Service.of({
              startTurn: () => Effect.die("unused"),
              cancelTurn: () => Effect.die("unused"),
              steerTurn: () => Effect.die("unused"),
              watchTurn: () => Stream.die("unused"),
              inspectTurn: () => Effect.succeed({ status: "unavailable" }),
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
