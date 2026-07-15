import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { Operation } from "@rika/app"
import { ConfigContract } from "@rika/config"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { MediaView, ParallelSearch, ReadWebPage, Runtime as ToolRuntime } from "@rika/tools"
import { ViewState } from "@rika/tui"
import { Surface } from "@rika/tui/adapter"
import { expect, test } from "bun:test"
import { Clock, Config, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  credentialForRoute,
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

test("selects only the credential named by each high and ultra main and Oracle gateway", () => {
  const openai = Redacted.make("openai-sentinel")
  const anthropic = Redacted.make("anthropic-sentinel")
  const credentials = { OPENAI_API_KEY: openai, ANTHROPIC_API_KEY: anthropic }
  const highMain = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "main")
  const highOracle = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const ultraMain = ConfigContract.resolveModelRoute(ConfigContract.defaults, "ultra", "main")
  const ultraOracle = ConfigContract.resolveModelRoute(ConfigContract.defaults, "ultra", "oracle")
  expect(credentialForRoute(highMain, credentials)).toEqual(openai)
  expect(credentialForRoute(highOracle, credentials)).toEqual(anthropic)
  expect(credentialForRoute(ultraMain, credentials)).toEqual(anthropic)
  expect(credentialForRoute(ultraOracle, credentials)).toEqual(openai)
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
        const context = yield* Effect.context<never>()
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("lease-finalized")).pipe(Effect.asVoid))
        const initialization = Effect.promise(() =>
          settleTuiInitialization(
            Effect.runPromiseWith(context)(Deferred.await(creation)),
            () => closed,
            () =>
              Effect.runPromiseWith(context)(
                Effect.sync(() => events.push("renderer-stopped", "renderer-idle", "renderer-destroyed")).pipe(
                  Effect.asVoid,
                ),
              ),
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
      const sessions: Array<Operation.InteractiveSession> = []
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
              Layer.merge(ParallelSearch.layer({}), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
            ),
            Layer.provide(BunServices.layer),
          ),
        defaultWorkspace: workspace,
        shellPermission: "allow",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
        makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${nextTurn++}`)),
        interactive: (_, session) => Effect.sync(() => sessions.push(session)),
      })
      const operation = Context.get(yield* Layer.buildWithScope(operationLayer, yield* Effect.scope), Operation.Service)
      const repositories = yield* Layer.buildWithScope(
        Layer.merge(repositoryLayer, turnRepositoryLayer),
        yield* Effect.scope,
      )
      yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      const session = sessions[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")

      const setup = yield* Effect.acquireRelease(
        Effect.promise(() => createTestRenderer({ width: 100, height: 30 })),
        (value) => Effect.sync(() => value.renderer.destroy()),
      )
      let model = ViewState.initial(workspace)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
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
        else if (event._tag === "ShellCompleted")
          model = ViewState.update(model, { _tag: "AssistantCompleted", text: event.text })
        else if (event._tag === "QueueChanged")
          model = ViewState.replaceQueue(
            model,
            event.turns
              .filter((turn) => turn.status === "queued")
              .map((turn) => ({ id: turn.id, prompt: turn.prompt })),
          )
        else if (event._tag === "QueuedTurnEdited")
          model = ViewState.replaceTurnPrompt(model, event.turnId, event.prompt)
        else if (
          event._tag !== "ThreadSelected" &&
          event._tag !== "TranscriptPageReceived" &&
          event._tag !== "TranscriptPagePrepended" &&
          event._tag !== "TranscriptPatched" &&
          event._tag !== "TranscriptResyncRequired" &&
          event._tag !== "ExecutionReplayed" &&
          event._tag !== "ExecutionControlled" &&
          event._tag !== "ExecutionEventReceived" &&
          event._tag !== "ThreadsListed" &&
          event._tag !== "ThreadTitled" &&
          event._tag !== "ThreadActivated" &&
          event._tag !== "ThreadPreviewLoaded" &&
          event._tag !== "TurnStarted"
        )
          model = ViewState.update(model, event)
        surface.update(model)
      }
      const run = Effect.fn("ShellSessionNativeTest.run")(function* (prompt: string) {
        const classified = ViewState.classifyPrompt(prompt)
        if (classified._tag !== "Shell") return yield* Effect.die("Expected shell prompt")
        yield* session.shell(classified.command, classified.incognito, dispatch)
        surface.update(model)
        yield* Effect.promise(() => setup.renderOnce())
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
          now,
        })
      }).pipe(Effect.provide(repositories))
      yield* run("$ printf queued-output")
      const queued = yield* Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        return yield* turns.listQueued(Thread.ThreadId.make("shell-thread"))
      }).pipe(Effect.provide(repositories))
      expect(queued).toHaveLength(1)
      expect(queued[0]?.prompt).toContain("queued-output")
      expect(setup.captureCharFrame()).toContain("queued-output")
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
