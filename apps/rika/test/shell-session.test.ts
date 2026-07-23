import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { Operation } from "@rika/app"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { MediaView, ReadWebPage, Runtime as ToolRuntime, WebSearch } from "@rika/tools"
import { ViewState } from "@rika/tui"
import { Surface } from "@rika/tui/adapter"
import { expect, test } from "vitest"
import { Clock, Config, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  interruptAndClearTrackedFiber,
  interruptTrackedFibers,
  refreshThreadsOnSwitcherOpen,
  settleTuiInitialization,
  tuiSignalExitCode,
} from "../src/main"

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
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        directory: temporaryDirectory,
        prefix: "rika-shell-session-",
      })
      const filename = path.join(workspace, "rika.db")
      const database = Database.layer(filename)
      const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
      const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
      const sessionReady = yield* Deferred.make<Operation.InteractiveSession>()
      const releaseSession = yield* Deferred.make<void>()
      let nextTurn = 0
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
        inspect: () => Effect.sync(() => undefined),
        replay: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.die("unused"),
      })
      const operationLayer = Operation.productLayer({
        repositoryLayer,
        turnRepositoryLayer,
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        toolRuntimeLayer: (directory) =>
          ToolRuntime.layer(directory).pipe(
            Layer.provide(
              MediaView.analyzerTestLayer(() =>
                Effect.fail(MediaView.MediaAnalysisError.make({ message: "Media analysis is unavailable" })),
              ),
            ),
            Layer.provide(
              Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
            ),
            Layer.provide(BunServices.layer),
            Layer.orDie,
          ),
        defaultWorkspace: workspace,
        shellPermission: "allow",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
        makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${nextTurn++}`)),
        interactive: (_, session) =>
          Deferred.succeed(sessionReady, session).pipe(Effect.andThen(Deferred.await(releaseSession))),
      })
      const operation = Context.get(yield* Layer.buildWithScope(operationLayer, yield* Effect.scope), Operation.Service)
      const repositories = yield* Layer.buildWithScope(
        Layer.merge(repositoryLayer, turnRepositoryLayer),
        yield* Effect.scope,
      )
      const operationFiber = yield* Effect.forkChild(
        operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
      )
      const session = yield* Deferred.await(sessionReady)

      const setup = yield* Effect.acquireRelease(
        Effect.tryPromise(() => createTestRenderer({ width: 100, height: 30 })),
        (value) => Effect.sync(() => value.renderer.destroy()),
      )
      let model = ViewState.resetQueue(ViewState.initial(workspace), "shell-thread", 0, [])
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
      const completedShells = yield* Queue.unbounded<string>()
      const dispatch = (event: Operation.InteractiveEvent) => {
        if (event._tag === "ShellPermissionRequested")
          model = ViewState.update(model, {
            _tag: "BlockAdded",
            block: {
              _tag: "Permission",
              id: event.id,
              kind: "permission",
              title: "Run shell command",
              detail: event.command,
              status: "pending",
            },
          })
        else if (event._tag === "ShellPermissionCancelled")
          model = ViewState.update(model, { _tag: "PermissionCancelled", id: event.id })
        else if (event._tag === "ShellCompleted") {
          model = ViewState.update(model, { _tag: "AssistantCompleted", text: event.text })
          Queue.offerUnsafe(completedShells, event.command)
        } else if (event._tag === "QueueUpdated") {
          if (event.change._tag === "Reset")
            model = ViewState.resetQueue(model, event.threadId, event.revision, event.change.items)
          else model = ViewState.applyQueueDelta(model, event.threadId, event.revision, event.change).model
        } else if (
          event._tag !== "SelectionLoaded" &&
          event._tag !== "TranscriptReplaced" &&
          event._tag !== "TranscriptPagePrepended" &&
          event._tag !== "TranscriptPatched" &&
          event._tag !== "TranscriptResyncRequired" &&
          event._tag !== "QueueResyncRequired" &&
          event._tag !== "QueueFull" &&
          event._tag !== "ExecutionControlled" &&
          event._tag !== "ContextDiagnostics" &&
          event._tag !== "ThreadsListed" &&
          event._tag !== "TitleCostUpdated" &&
          event._tag !== "ThreadUsageUpdated" &&
          event._tag !== "ThreadTitled" &&
          event._tag !== "ThreadActivated" &&
          event._tag !== "ThreadPreviewLoaded" &&
          event._tag !== "TurnStarted"
        )
          model = ViewState.update(model, event)
        surface.update(model)
      }
      yield* Effect.forkChild(session.events(dispatch))
      yield* Effect.yieldNow
      const run = Effect.fn("ShellSessionNativeTest.run")(function* (prompt: string) {
        const classified = ViewState.classifyPrompt(prompt)
        if (classified._tag !== "Shell") return yield* Effect.die("Expected shell prompt")
        yield* session.shell(classified.command, classified.incognito)
        expect(yield* Queue.take(completedShells)).toBe(classified.command)
        surface.update(model)
        yield* Effect.tryPromise(() => setup.renderOnce())
        return setup.captureCharFrame()
      })

      const recordedFrame = yield* run("$ printf recorded-output")
      expect(recordedFrame).not.toContain("Run shell command")
      expect(recordedFrame).toContain("recorded-output")
      const incognitoFrame = yield* run("$$ printf incognito-output")
      expect(incognitoFrame).toContain("incognito-output")

      const persisted = yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        return {
          threads: yield* threads.list({ includeArchived: true }),
          turns: yield* turns.list(Thread.ThreadId.make("shell-thread")),
        }
      }).pipe(Effect.provide(repositories))
      expect(persisted.threads).toHaveLength(1)
      expect(persisted.turns).toHaveLength(1)
      expect(persisted.turns[0]?.prompt).toContain("recorded-output")
      expect(persisted.turns[0]?.prompt).not.toContain("incognito-output")

      yield* Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        const now = yield* Clock.currentTimeMillis
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("active"),
          threadId: Thread.ThreadId.make("shell-thread"),
          prompt: "active",
          executionRoute: Turn.testExecutionRoute(),
          queueCapacity: 128,
          now,
        })
      }).pipe(Effect.provide(repositories))
      yield* run("$ printf queued-output")
      const queued = yield* Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        return (yield* turns.readQueue(Thread.ThreadId.make("shell-thread"))).turns
      }).pipe(Effect.provide(repositories))
      expect(queued).toHaveLength(1)
      expect(queued[0]?.prompt).toContain("queued-output")
      expect(setup.captureCharFrame()).toContain("queued-output")
      yield* Deferred.succeed(releaseSession, undefined)
      yield* Fiber.join(operationFiber)
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* Effect.provide(program, services)
      }),
    ),
  )
})
