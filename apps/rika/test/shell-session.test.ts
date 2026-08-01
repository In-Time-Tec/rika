import { MediaAnalysisError } from "@rika/coding-tools/media-view-service"
import { analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import {
  productLayer,
  Service,
  type InteractiveEvent,
  type InteractiveSession,
} from "@rika/product/product-operation-service"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as ViewState from "@rika/terminal/terminal-state"
import { Surface } from "@rika/terminal/opentui-surface"
import { expect, test } from "vitest"
import { Clock, Config, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  interruptAndClearTrackedFiber,
  interruptTrackedFibers,
  refreshThreadsOnSwitcherOpen,
  settleTuiInitialization,
  tuiSignalExitCode,
} from "../src/interactive-main"
import * as InteractiveController from "../src/interactive-controller"

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
      const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
        Layer.provide(database),
        Layer.provide(BunServices.layer),
      )
      const sessionReady = yield* Deferred.make<InteractiveSession>()
      const releaseSession = yield* Deferred.make<void>()
      let nextTurn = 0
      const relayReads: Array<"inspect" | "replay"> = []
      const backend = ExecutionBackend.Service.of({
        invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
        resolveInvocationSource: () => Effect.die("unused"),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        inspect: () =>
          Effect.sync(() => {
            relayReads.push("inspect")
            return undefined
          }),
        replay: (turnId) =>
          Effect.sync(() => {
            relayReads.push("replay")
            return { turnId, status: "completed" as const, events: [] }
          }),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
      })
      const operationLayer = productLayer({
        repositoryLayer,
        turnRepositoryLayer,
        transcriptRepositoryLayer,
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        toolRuntimeLayer: (directory) =>
          ToolRuntime.layer(directory).pipe(
            Layer.provide(
              analyzerTestLayer(() =>
                Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" })),
              ),
            ),
            Layer.provide(
              Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
            ),
            Layer.provide(BunServices.layer),
            Layer.orDie,
          ),
        defaultWorkspace: workspace,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
        makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${nextTurn++}`)),
        interactive: (_, session) =>
          Deferred.succeed(sessionReady, session).pipe(Effect.andThen(Deferred.await(releaseSession))),
      })
      const operation = Context.get(yield* Layer.buildWithScope(operationLayer, yield* Effect.scope), Service)
      const repositories = yield* Layer.buildWithScope(
        Layer.mergeAll(repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer),
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
      let controller: InteractiveController.State = {
        model: ViewState.resetQueue(ViewState.initial(workspace), "shell-thread", 0, []),
        selectionEpoch: 0,
        replayTurns: new Map(),
        entries: [],
        revisions: new Map(),
        liveProjections: new Map(),
      }
      let model = controller.model
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
      const completedShells = yield* Queue.unbounded<string>()
      const dispatch = (event: InteractiveEvent) => {
        if (event._tag === "ShellCompleted") {
          if (event.incognito) model = ViewState.update(model, { _tag: "AssistantCompleted", text: event.text })
          model = ViewState.update(model, { _tag: "ExecutionCompleted" })
          Queue.offerUnsafe(completedShells, event.command)
        } else if (event._tag === "QueueUpdated") {
          if (event.change._tag === "Reset")
            model = ViewState.resetQueue(model, event.threadId, event.revision, event.change.items)
          else model = ViewState.applyQueueDelta(model, event.threadId, event.revision, event.change).model
        } else if (
          event._tag === "SelectionLoaded" ||
          event._tag === "TranscriptPagePrepended" ||
          event._tag === "TranscriptPageAppended" ||
          event._tag === "TranscriptProjectionStarted" ||
          event._tag === "TranscriptProjectionPatched" ||
          event._tag === "TranscriptProjectionStopped" ||
          event._tag === "TranscriptProjectionFailed" ||
          event._tag === "TranscriptResyncRequired" ||
          event._tag === "ThreadUsageUpdated" ||
          event._tag === "ThreadRefolding"
        ) {
          controller = InteractiveController.update({ ...controller, model }, event).state
          model = controller.model
        } else if (
          event._tag !== "QueueResyncRequired" &&
          event._tag !== "QueueFull" &&
          event._tag !== "ExecutionControlFailed" &&
          event._tag !== "ExecutionControlled" &&
          event._tag !== "ContextDiagnostics" &&
          event._tag !== "ThreadsListed" &&
          event._tag !== "TitleCostUpdated" &&
          event._tag !== "ThreadTitled" &&
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
      yield* session.reopenThread(1)
      expect(relayReads).toEqual([])
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
        executionCheckpoints: [],
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
