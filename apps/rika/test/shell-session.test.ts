import * as InteractiveEvent from "@rika/product/interactive-event"
import * as BunServices from "@effect/platform-bun/BunServices"
import { startShellOperation } from "./shell-session-operation"
import { createTestRenderer } from "@opentui/core/testing"
import * as ThreadRepository from "@rika/store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { initial } from "@rika/terminal/terminal-state"
import * as TerminalReducer from "@rika/terminal/terminal-state-reducer"
import { classifyPrompt } from "@rika/terminal/terminal-session"
import { Surface } from "@rika/terminal/opentui-surface"
import { expect, test } from "vitest"
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue, Scope } from "effect"
import {
  interruptAndClearTrackedFiber,
  interruptTrackedFibers,
  refreshThreadsOnSwitcherOpen,
  settleTuiInitialization,
  tuiSignalExitCode,
} from "../src/interactive/process/process-lifecycle"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"

test("maps TUI signals to numeric process exit codes", () => {
  expect(tuiSignalExitCode("SIGINT")).toBe(130)
  expect(tuiSignalExitCode("SIGTERM")).toBe(143)
})

test("awaits tracked fiber cleanup before releasing its enclosing lease", () => {
  const events: Array<string> = []
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("lease-released")).pipe(Effect.asVoid))
        const started = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => events.push("fiber-cleaned")).pipe(Effect.asVoid)),
          ),
        )
        yield* Deferred.await(started)
        yield* interruptTrackedFibers([fiber])
        events.push("shutdown-resumed")
      }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => expect(events).toEqual(["fiber-cleaned", "shutdown-resumed", "lease-released"])),
      ),
    ),
  )
})

test("clears an interrupted follow so a newly selected thread can be followed", () => {
  let followed = 0
  let tracked: Fiber.Fiber<void, never> | undefined
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const startFollow = Effect.gen(function* () {
          if (tracked !== undefined) return
          followed += 1
          tracked = yield* Effect.forkChild(Effect.never)
        })
        yield* startFollow
        const previous = tracked!
        yield* interruptAndClearTrackedFiber(previous, (fiber) => {
          if (tracked === fiber) tracked = undefined
        })
        yield* startFollow
        expect(tracked).not.toBe(previous)
      }),
    ).pipe(Effect.andThen(Effect.sync(() => expect(followed).toBe(2)))),
  )
})

test("refreshes threads only when the switcher transitions from closed to open", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let refreshes = 0
      const initialize = Effect.sync(() => {
        refreshes += 1
      })
      yield* refreshThreadsOnSwitcherOpen(false, true, initialize)
      yield* refreshThreadsOnSwitcherOpen(true, true, initialize)
      yield* refreshThreadsOnSwitcherOpen(true, false, initialize)
      expect(refreshes).toBe(1)
    }),
  ))

test("awaits delayed TUI initialization and tears down its renderer before lease finalization", () => {
  const events: Array<string> = []
  let closed = false
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const creation = yield* Deferred.make<{ readonly renderer: string }>()
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("lease-finalized")).pipe(Effect.asVoid))
        const initialization = settleTuiInitialization(
          Deferred.await(creation),
          () => closed,
          () =>
            Effect.sync(() => events.push("renderer-stopped", "renderer-idle", "renderer-destroyed")).pipe(
              Effect.asVoid,
            ),
        ).pipe(
          Effect.tap((created) =>
            created !== undefined && !closed ? Effect.sync(() => events.push("post-close-work-started")) : Effect.void,
          ),
        )
        closed = true
        events.push("close-started")
        const close = initialization.pipe(
          Effect.andThen(Effect.sync(() => events.push("shutdown-resumed"))),
          Effect.asVoid,
        )
        const closeFiber = yield* Effect.forkChild(close)
        yield* Effect.yieldNow
        expect(events).toEqual(["close-started"])
        yield* Deferred.succeed(creation, { renderer: "delayed" })
        yield* Fiber.join(closeFiber)
      }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() =>
          expect(events).toEqual([
            "close-started",
            "renderer-stopped",
            "renderer-idle",
            "renderer-destroyed",
            "shutdown-resumed",
            "lease-finalized",
          ]),
        ),
      ),
    ),
  )
})

test("drives bypassed recorded and incognito shell commands through Operation and native OpenTUI", () => {
  const operation: Effect.Effect<void, never, BunServices.BunServices | Scope.Scope> = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const operationSetup = yield* startShellOperation({ fileSystem, path })
    const { workspace, repositories, operationFiber, session, releaseSession, executionReads } = operationSetup
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 100, height: 30 })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    let controller: InteractiveController.State = {
      model: TerminalReducer.resetQueue(initial(workspace), "shell-thread", 0, []),
    }
    let model = controller.model
    const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
    yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
    const completedShells = yield* Queue.unbounded<string>()
    const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
      if (event._tag === "ShellCompleted") {
        if (event.incognito) model = TerminalReducer.update(model, { _tag: "AssistantCompleted", text: event.text })
        model = TerminalReducer.update(model, { _tag: "ExecutionCompleted" })
        Queue.offerUnsafe(completedShells, event.command)
      } else if (
        event._tag === "ThreadViewSnapshot" ||
        event._tag === "ThreadViewPatch" ||
        event._tag === "ResyncRequired" ||
        event._tag === "ThreadRefolding"
      ) {
        controller = InteractiveController.update({ ...controller, model }, event).state
        model = controller.model
      } else if (
        event._tag !== "QueueFull" &&
        event._tag !== "ExecutionControlFailed" &&
        event._tag !== "ExecutionControlled" &&
        event._tag !== "ContextDiagnostics" &&
        event._tag !== "ThreadsListed" &&
        event._tag !== "ThreadTitled" &&
        event._tag !== "ThreadPreviewLoaded" &&
        event._tag !== "TurnStarted"
      )
        model = TerminalReducer.update(model, event)
      surface.update(model)
    }
    yield* Effect.forkChild(session.events(dispatch))
    yield* Effect.yieldNow
    const run = Effect.fn("ShellSessionNativeTest.run")(function* (prompt: string) {
      const classified = classifyPrompt(prompt)
      if (classified._tag !== "Shell") return yield* Effect.die("Expected shell prompt")
      yield* session.shell(
        model.currentThreadId === undefined ? undefined : Thread.ThreadId.make(model.currentThreadId),
        classified.command,
        classified.incognito,
      )
      expect(yield* Queue.take(completedShells)).toBe(classified.command)
      surface.update(model)
      yield* Effect.tryPromise(() => setup.renderOnce())
      return setup.captureCharFrame()
    })

    const recordedFrame = yield* run("$ printf recorded-output")
    expect(recordedFrame).not.toContain("Run shell command")
    expect(recordedFrame).toContain("recorded-output")
    yield* session.reopenThread
    expect(executionReads).toEqual([])
    expect(model.blocks).toContainEqual(
      expect.objectContaining({
        _tag: "ToolCall",
        detail: "printf recorded-output",
        output: "recorded-output",
        status: "complete",
      }),
    )
    const incognitoFrame = yield* run("$$ printf incognito-output")
    expect(incognitoFrame).toContain("incognito-output")

    const persisted = yield* Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const storedTurns = yield* turns.list(Thread.ThreadId.make("shell-thread"))
      return {
        threads: yield* threads.list({ includeArchived: true }),
        turns: storedTurns,
        projection: storedTurns[0] === undefined ? undefined : yield* transcripts.get(storedTurns[0].id),
      }
    }).pipe(Effect.provide(repositories))
    expect(persisted.threads).toHaveLength(1)
    expect(persisted.turns).toHaveLength(1)
    expect(persisted.turns[0]?.prompt).toContain("recorded-output")
    expect(persisted.turns[0]?.prompt).not.toContain("incognito-output")
    expect(persisted.projection).toMatchObject({
      turn: { _tag: "RecordedShell", status: "completed" },
      units: [{ content: { _tag: "Block", block: { _tag: "ToolCall", output: "recorded-output" } } }],
    })

    yield* Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const now = yield* Clock.currentTimeMillis
      yield* turns.createForSubmission({
        id: Turn.TurnId.make("active"),
        threadId: Thread.ThreadId.make("shell-thread"),
        prompt: "active",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
        queueCapacity: 128,
        now,
      })
    }).pipe(Effect.provide(repositories))
    const alongsideFrame = yield* run("$ printf alongside-output")
    const alongside = yield* Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      return {
        queue: (yield* turns.readQueue(Thread.ThreadId.make("shell-thread"))).turns,
        turns: yield* turns.list(Thread.ThreadId.make("shell-thread")),
      }
    }).pipe(Effect.provide(repositories))
    expect(alongside.queue).toEqual([])
    expect(alongside.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: "AgentExecution", id: "active", status: "accepted" }),
        expect.objectContaining({
          _tag: "RecordedShell",
          command: "printf alongside-output",
          status: "completed",
        }),
      ]),
    )
    expect(model.blocks).toContainEqual(
      expect.objectContaining({
        _tag: "ToolCall",
        detail: "printf alongside-output",
        output: "alongside-output",
        status: "complete",
      }),
    )
    expect(alongsideFrame).toContain("$ printf recorded-output")
    expect(alongsideFrame).toContain("$ printf alongside-output")
    expect(alongsideFrame).not.toContain("Ran 2 commands")
    yield* Deferred.succeed(releaseSession, undefined)
    yield* Fiber.join(operationFiber)
  }).pipe(Effect.orDie)
  const program: Effect.Effect<void, never, BunServices.BunServices> = Effect.scoped(operation)
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* Effect.provide(program, services)
      }),
    ),
  )
}, 30_000)
