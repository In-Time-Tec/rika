import * as InteractiveSession from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import type * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { productLayer, Service } from "@rika/product/product-operation-service"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import type { ModeConfiguration } from "@rika/terminal/terminal-state"
import {
  Clock,
  Config,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Scope,
  SubscriptionRef,
} from "effect"
import { interactiveTui } from "../../src/interactive/process/lifecycle/loop"
import * as TuiRepositories from "./tui-repositories.harness"
import type { HistoricalTranscriptFixture, TuiAppQueue } from "./tui-repositories.harness"
import type { Lane, LaneModels, Profile, ProviderHttpEnvelopeCounts } from "./tui-model.fixture"
import { tuiToolRuntimeLayer } from "./tui-tool-runtime.harness"
import {
  backendLayer,
  kernelPoolFor,
  prepareTuiRuntimeState,
  type RuntimeStatePreparation,
} from "./tui-backend.harness"
import * as TuiModel from "./tui-model.fixture"

type InteractiveConnection = Parameters<ReturnType<typeof interactiveTui>>[2]
type InteractiveConnectionState = InteractiveConnection["initialState"]

/**
 * Settling means no work is still in flight, so a running subagent counts. `Running` covers every
 * running-tools label the activity line produces — a cell, a subagent, or several of either — which
 * an exact "Running 1 tool" misses the moment a turn delegates.
 */
const activityMarkers = ["Waiting", "Streaming", "Running", "Thinking"] as const

type SessionEvent = Parameters<Parameters<InteractiveSession.InteractiveSession["events"]>[0]>[0]

export interface TuiAppOptions {
  readonly script?: Lane["steps"]
  readonly initialPrompt?: ReadonlyArray<string>
  readonly lanes?: ReadonlyArray<Lane>
  readonly subagents?: ExecutionRouteSnapshot.ExecutionRouteSnapshot["subagents"]
  readonly root?: string
  readonly initialThreadId?: string
  readonly initialThreadSelected?: boolean
  readonly idStart?: number
  readonly inspectTranscript?: boolean
  readonly workspaceFiles?: Readonly<Record<string, string>>
  readonly width?: number
  readonly height?: number
  readonly initialConnectionState?: InteractiveConnectionState
  readonly holdSubmissionAdmission?: Deferred.Deferred<void>
  readonly holdCancellation?: Deferred.Deferred<void>
  readonly mapInteractiveEvent?: (event: SessionEvent) => SessionEvent
  readonly duplicateInteractiveEvent?: (event: SessionEvent) => boolean
  readonly submissionFailure?: (attempt: number) => string | undefined
  readonly newOrbThreadFailure?: string
  readonly historicalTranscriptFixture?: HistoricalTranscriptFixture
  readonly prepareRuntimeState?: RuntimeStatePreparation
  readonly modeConfiguration?: ModeConfiguration
}

export type CapturedSpans = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

export interface TuiApp {
  readonly workspace: string
  readonly type: (text: string) => ReturnType<typeof Effect.runPromise<void, never>>
  readonly paste: (text: string) => void
  readonly pressEnter: () => void
  readonly pressEscape: () => void
  readonly pressArrow: (direction: "up" | "down" | "left" | "right") => void
  readonly pressKey: (key: string, modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean }) => void
  readonly pressPageUp: Effect.Effect<void>
  readonly pressPageDown: Effect.Effect<void>
  readonly clickText: (text: string) => Effect.Effect<void>
  readonly clickComposer: Effect.Effect<void>
  readonly submit: (prompt: string) => Effect.Effect<void>
  readonly frame: () => string
  readonly nextFrame: Effect.Effect<string>
  readonly spans: () => CapturedSpans
  readonly thread: (threadId: string) => Effect.Effect<Thread.Thread | undefined, ThreadRepository.RepositoryError>
  readonly waitThread: (
    threadId: string,
    predicate: (thread: Thread.Thread) => boolean,
    timeoutMillis?: number,
  ) => Effect.Effect<Thread.Thread, ThreadRepository.RepositoryError>
  readonly transcript: (
    turnId: Turn.TurnId,
  ) => Effect.Effect<TranscriptPage.Projection | undefined, TranscriptRepository.RepositoryError>
  readonly queue: TuiAppQueue
  readonly waitTranscript: (
    turnId: Turn.TurnId,
    predicate: (projection: TranscriptPage.Projection) => boolean,
    timeoutMillis?: number,
  ) => Effect.Effect<TranscriptPage.Projection, TranscriptRepository.RepositoryError>
  readonly waitFrame: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitFrameMatch: (predicate: (frame: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitCost: Effect.Effect<string>
  readonly waitGone: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitTerminalTitle: (predicate: (title: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly settled: Effect.Effect<string>
  readonly reload: Effect.Effect<void>
  readonly waitModelRequests: (count: number) => Effect.Effect<void>
  readonly waitSubmissionAdmissions: (count: number) => Effect.Effect<void>
  readonly setConnectionState: (state: InteractiveConnectionState) => Effect.Effect<void>
  readonly modelRequestCount: Effect.Effect<number>
  readonly submissionAttempts: Effect.Effect<number>
  readonly modelProviderHttpEnvelopeCounts: Effect.Effect<ProviderHttpEnvelopeCounts>
  readonly modelPrompts: ReturnType<LaneModels["promptsFor"]>
  readonly modelToolNamesFor: (profile: Profile) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  readonly close: () => void
  readonly done: Effect.Effect<void>
  readonly quit: Effect.Effect<void>
}

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

const start = Effect.fn("TuiApp.start")(function* (options: TuiAppOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  const root =
    options.root ??
    (yield* fileSystem.makeTempDirectoryScoped({ directory: temporaryDirectory, prefix: "rika-tui-app-" }))
  const workspace = path.join(root, "workspace")
  const resourceScope = yield* Scope.make()
  /**
   * Teardown is awaited rather than forked. These resources include a pool of real kernel workers,
   * and a fire-and-forget close returns before any of them dies, so the next test in the file starts
   * while the previous one's workers are still running and competing for the machine.
   */
  yield* Effect.addFinalizer(() => Scope.close(resourceScope, Exit.void))
  yield* fileSystem.makeDirectory(workspace, { recursive: true })
  for (const [name, content] of Object.entries(options.workspaceFiles ?? {})) {
    const target = path.join(workspace, name)
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
    yield* fileSystem.writeFileString(target, content)
  }
  const lanes = options.lanes ?? [{ steps: options.script ?? [] }]
  const laneModels = yield* TuiModel.makeLaneModels(lanes)
  const awaitModelRequests = (count: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      for (;;) {
        const requests = yield* laneModels.requestCountFor("Root")
        if (requests >= count) return
        const now = yield* Clock.currentTimeMillis
        if (now - started >= 10_000)
          return yield* Effect.die(`tui-app timed out waiting for ${count} model requests; observed ${requests}`)
        yield* Effect.sleep("5 millis")
      }
    })
  const {
    repositoryLayer,
    turnRepositoryLayer,
    threadSearchRepositoryLayer,
    threadSummaryRepositoryLayer,
    transcriptRepositoryLayer,
  } = TuiRepositories.makeTuiAppRepositoryLayers()
  const repositoryContext = yield* Layer.buildWithScope(
    Layer.mergeAll(
      repositoryLayer,
      turnRepositoryLayer,
      threadSearchRepositoryLayer,
      threadSummaryRepositoryLayer,
      transcriptRepositoryLayer,
    ),
    resourceScope,
  )
  const repositories = Layer.succeedContext(repositoryContext)
  if (options.historicalTranscriptFixture !== undefined)
    yield* TuiRepositories.seedHistoricalTranscript(options.historicalTranscriptFixture, workspace).pipe(
      Effect.provide(repositoryContext),
    )
  const toolRuntimeContext = yield* Layer.buildWithScope(tuiToolRuntimeLayer(workspace), resourceScope)
  const toolRuntimeLayer = Layer.succeedContext(toolRuntimeContext)
  const toolRuntime = Context.get(toolRuntimeContext, ToolRuntime.Service)
  const queryFactoryLayer = Layer.succeedContext(
    yield* Layer.buildWithScope(ThreadQuery.Runtime.factoryLayer.pipe(Layer.provide(repositories)), resourceScope),
  )
  const kernelPool = yield* kernelPoolFor({
    workspace,
    dataRoot: root,
    queryFactoryLayer,
    toolRuntimeLayer,
  })
  const executionBackendContext = yield* Layer.buildWithScope(
    backendLayer({
      dataRoot: root,
      kernelPool,
      registryLayer: laneModels.registryLayer,
      toolRuntimeLayer,
      queryFactoryLayer,
    }),
    resourceScope,
  )
  const executionBackendLayer = Layer.succeedContext(executionBackendContext)
  yield* prepareTuiRuntimeState({
    preparation: options.prepareRuntimeState,
    workspace,
    executionBackendContext,
    repositoryContext,
    waitModelRequests: awaitModelRequests,
  })
  const setup = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30, exitOnCtrlC: false }),
    ),
    (created) => Effect.sync(() => created.renderer.destroy()).pipe(Effect.ignore),
  )
  const terminalTitles: Array<string> = []
  let nextThread = options.idStart ?? 0
  let nextTurn = options.idStart ?? 0
  let session: InteractiveSession.InteractiveSession | undefined
  const initialConnectionState = options.initialConnectionState ?? {
    connectivity: "connected",
    target: "runner",
    participants: 1,
  }
  const connectionState = yield* SubscriptionRef.make<InteractiveConnectionState>(initialConnectionState)
  const interactiveConnection: InteractiveConnection = {
    initialState: initialConnectionState,
    stateChanges: SubscriptionRef.changes(connectionState),
  }
  let selectionsLoaded = 0
  let submissionAdmissions = 0
  let submissionAttempts = 0
  const awaitSelectionLoaded = (count: number): Effect.Effect<void> =>
    Effect.suspend(() =>
      selectionsLoaded >= count
        ? Effect.void
        : Effect.sleep("10 millis").pipe(Effect.andThen(awaitSelectionLoaded(count))),
    )
  const runInteractive = interactiveTui({
    modeConfiguration: () => options.modeConfiguration,
    makeRenderer: () => Effect.succeed(setup.renderer),
    writeTerminalTitle: (sequence) => terminalTitles.push(sequence.slice(4, -1)),
  })
  const operationLayer = productLayer({
    executionSessionLifecycleLayer: executionBackendLayer,
    repositoryLayer: repositories,
    turnRepositoryLayer: repositories,
    transcriptRepositoryLayer: repositories,
    threadSummaryRepositoryLayer: repositories,
    backendLayer: executionBackendLayer,
    toolRuntimeLayer: () => Layer.succeed(ToolRuntime.Service, toolRuntime),
    defaultWorkspace: workspace,
    makeThreadId: Effect.sync(() => Thread.ThreadId.make(`tui-thread-${nextThread++}`)),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`tui-turn-${nextTurn++}`)),
    resolveExecutionRoute: (mode) => {
      const route = TuiModel.laneExecutionRoute(mode)
      return Effect.succeed(options.subagents === undefined ? route : { ...route, subagents: options.subagents })
    },
    interactive: (settings, current) => {
      session = current
      const tuiSession: InteractiveSession.InteractiveSession = {
        ...current,
        submit: (prompt, mode, parts, tuning, submissionId) => {
          submissionAttempts += 1
          const failed = options.submissionFailure?.(submissionAttempts)
          const submitted =
            failed === undefined
              ? current.submit(prompt, mode, parts, tuning, submissionId)
              : Effect.fail(ProductOperation.OperationUnavailable.make({ operation: "Submit", message: failed }))
          return options.holdSubmissionAdmission === undefined
            ? submitted
            : Deferred.await(options.holdSubmissionAdmission).pipe(Effect.andThen(submitted))
        },
        cancel: (target) => {
          const cancelled = current.cancel(target)
          return options.holdCancellation === undefined
            ? cancelled
            : Deferred.await(options.holdCancellation).pipe(Effect.andThen(cancelled))
        },
        events: (dispatch) =>
          current.events((event) => {
            const delivered = options.mapInteractiveEvent?.(event) ?? event
            dispatch(delivered)
            if (options.duplicateInteractiveEvent?.(delivered) === true) dispatch(delivered)
            if (delivered._tag === "ThreadViewSnapshot") selectionsLoaded += 1
            if (delivered._tag === "SubmissionAdmitted") submissionAdmissions += 1
          }),
        selectThread: (threadId) =>
          options.initialThreadSelected === true && threadId === settings.threadId
            ? Effect.void
            : current.selectThread(threadId),
      }
      if (options.newOrbThreadFailure !== undefined)
        Object.assign(tuiSession, {
          newOrbThread: Effect.fail(
            ProductOperation.OperationUnavailable.make({
              operation: "New Orb Thread",
              message: options.newOrbThreadFailure,
            }),
          ),
        })
      const open = runInteractive(settings, tuiSession, interactiveConnection)
      return options.initialThreadSelected === true && settings.threadId !== undefined
        ? current.selectThread(settings.threadId).pipe(Effect.andThen(open))
        : open
    },
  })
  const operation = Context.get(yield* Layer.buildWithScope(operationLayer, resourceScope), Service)
  const threads = Context.get(repositoryContext, ThreadRepository.Service)
  const transcripts =
    options.inspectTranscript === true ? Context.get(repositoryContext, TranscriptRepository.Service) : undefined
  const queue = TuiRepositories.makeTuiAppQueue(repositoryContext)
  const operationFiber = yield* Effect.forkChild(
    operation
      .run(
        options.initialThreadId === undefined
          ? { _tag: "Interactive", prompt: options.initialPrompt ?? [], workspace, ephemeral: false }
          : {
              _tag: "Interactive",
              prompt: options.initialPrompt ?? [],
              workspace,
              ephemeral: false,
              threadId: options.initialThreadId,
            },
      )
      .pipe(Effect.orDie),
  )
  yield* Effect.addFinalizer(() => Fiber.interrupt(operationFiber).pipe(Effect.asVoid))
  const frame = () => setup.captureCharFrame()
  const renderOnce = Effect.tryPromise(() => setup.renderOnce()).pipe(
    Effect.orDie,
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.die("tui-app renderer did not complete a fallback frame"),
    }),
  )
  const flushRenderer = Effect.tryPromise(() => setup.flush()).pipe(
    Effect.catch(() => renderOnce),
    Effect.timeoutOrElse({ duration: "1 second", orElse: () => renderOnce }),
  )
  const waitFor = (predicate: (frame: string) => boolean, timeoutMillis: number, description: string) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      for (;;) {
        yield* flushRenderer
        const captured = frame()
        if (predicate(captured)) return captured
        const now = yield* Clock.currentTimeMillis
        if (now - started >= timeoutMillis) {
          return yield* Effect.die(`tui-app timed out waiting for ${description}\n${captured}`)
        }
        yield* Effect.sleep("20 millis")
      }
    })
  const waitTerminalTitle = (predicate: (title: string) => boolean, timeoutMillis: number) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      for (;;) {
        const title = terminalTitles.at(-1)
        if (title !== undefined && predicate(title)) return title
        const now = yield* Clock.currentTimeMillis
        if (now - started >= timeoutMillis)
          return yield* Effect.die(`tui-app timed out waiting on terminal title\n${title ?? "<unset>"}`)
        yield* Effect.sleep("20 millis")
      }
    })
  const settled = waitFor(
    (captured) => !activityMarkers.some((marker) => captured.includes(marker)),
    10_000,
    "settled frame",
  )
  const app: TuiApp = {
    workspace,
    type: (text) => setup.mockInput.typeText(text),
    paste: (text) => setup.mockInput.pasteBracketedText(text),
    pressEnter: () => setup.mockInput.pressEnter(),
    pressEscape: () => setup.mockInput.pressEscape(),
    pressArrow: (direction) => setup.mockInput.pressArrow(direction),
    pressKey: (key, modifiers) =>
      modifiers?.alt === true ? setup.mockInput.pressKey(`\u001b${key}`) : setup.mockInput.pressKey(key, modifiers),
    pressPageUp: Effect.gen(function* () {
      setup.mockInput.pressKey("\u001b[5~")
      yield* Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie)
      yield* Effect.yieldNow
      yield* Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie)
    }).pipe(Effect.asVoid),
    pressPageDown: Effect.gen(function* () {
      setup.mockInput.pressKey("\u001b[6~")
      yield* Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie)
      yield* Effect.yieldNow
      yield* Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie)
    }).pipe(Effect.asVoid),
    clickText: (text) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie)
        const lines = frame().split("\n")
        const y = lines.findIndex((line) => line.includes(text))
        const x = y < 0 ? -1 : lines[y]!.indexOf(text)
        if (x < 0 || y < 0) return yield* Effect.die(`tui-app could not click missing text: ${text}`)
        yield* Effect.tryPromise(() => setup.mockMouse.click(x, y)).pipe(Effect.orDie)
      }),
    clickComposer: Effect.gen(function* () {
      yield* Effect.tryPromise(() => setup.flush())
      yield* Effect.tryPromise(() => setup.mockMouse.click(2, (options.height ?? 30) - 2))
    }).pipe(Effect.orDie, Effect.asVoid),
    submit: (prompt) =>
      session?.submit(prompt, "medium", [], undefined).pipe(Effect.orDie) ??
      Effect.die("TUI interactive session is not ready"),
    frame,
    nextFrame: Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie, Effect.andThen(Effect.sync(frame))),
    spans: () => setup.captureSpans(),
    thread: (threadId) => threads.get(Thread.ThreadId.make(threadId)),
    waitThread: (threadId, predicate, timeoutMillis = 10_000) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        for (;;) {
          const thread = yield* threads.get(Thread.ThreadId.make(threadId))
          if (thread !== undefined && predicate(thread)) return thread
          const now = yield* Clock.currentTimeMillis
          if (now - started >= timeoutMillis)
            return yield* Effect.die(`tui-app timed out waiting on thread ${threadId}`)
          yield* Effect.sleep("20 millis")
        }
      }),
    transcript: (turnId) => transcripts?.get(turnId) ?? Effect.die("TUI transcript inspection was not requested"),
    queue,
    waitTranscript: (turnId, predicate, timeoutMillis = 10_000) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        for (;;) {
          const projection = yield* transcripts?.get(turnId) ??
            Effect.die("TUI transcript inspection was not requested")
          if (projection !== undefined && predicate(projection)) return projection
          const now = yield* Clock.currentTimeMillis
          if (now - started >= timeoutMillis)
            return yield* Effect.die(`tui-app timed out waiting on the durable transcript for ${turnId}`)
          yield* Effect.sleep("20 millis")
        }
      }),
    waitFrame: (marker, timeoutMillis = 10_000) =>
      waitFor((captured) => captured.includes(marker), timeoutMillis, `frame containing ${marker}`),
    waitFrameMatch: (predicate, timeoutMillis = 10_000) => waitFor(predicate, timeoutMillis, "matching frame"),
    waitCost: waitFor((captured) => /\$[0-9]/u.test(captured), 10_000, "cost frame"),
    waitGone: (marker, timeoutMillis = 10_000) =>
      waitFor((captured) => !captured.includes(marker), timeoutMillis, `frame without ${marker}`),
    waitTerminalTitle: (predicate, timeoutMillis = 10_000) => waitTerminalTitle(predicate, timeoutMillis),
    settled,
    reload: Effect.gen(function* () {
      const current = session
      if (current === undefined) return yield* Effect.die("TUI session is unavailable")
      const before = selectionsLoaded
      yield* current.reopenThread.pipe(Effect.orDie)
      yield* awaitSelectionLoaded(before + 1)
    }),
    waitModelRequests: awaitModelRequests,
    waitSubmissionAdmissions: (count) =>
      Effect.suspend(() =>
        submissionAdmissions >= count
          ? Effect.void
          : Effect.sleep("10 millis").pipe(Effect.andThen(app.waitSubmissionAdmissions(count))),
      ),
    setConnectionState: (state) => SubscriptionRef.set(connectionState, state),
    modelRequestCount: laneModels.requestCountFor("Root"),
    submissionAttempts: Effect.sync(() => submissionAttempts),
    modelProviderHttpEnvelopeCounts: laneModels.providerHttpEnvelopeCountsFor("Root"),
    modelPrompts: laneModels.promptsFor("Root"),
    modelToolNamesFor: (profile) =>
      laneModels
        .requestsFor(profile)
        .pipe(Effect.map((requests) => requests.map((request) => request.tools.map((tool) => tool.name).toSorted()))),
    close: () => setup.mockInput.pressCtrlC(),
    done: Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie),
    quit: Effect.gen(function* () {
      yield* settled
      setup.mockInput.pressCtrlC()
      yield* Effect.tryPromise(() => setup.flush()).pipe(Effect.orDie)
      setup.mockInput.pressCtrlC()
      yield* Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie)
    }),
  }
  const readyModes =
    options.modeConfiguration === undefined ? ["medium"] : Object.keys(options.modeConfiguration.routes)
  yield* app.waitFrameMatch((captured) => readyModes.some((mode) => captured.includes(mode)))
  if (options.historicalTranscriptFixture !== undefined) {
    const current = session ?? (yield* Effect.die("TUI session is unavailable"))
    const before = selectionsLoaded
    yield* current.selectThread(options.historicalTranscriptFixture.threadId).pipe(Effect.orDie)
    yield* awaitSelectionLoaded(before + 1)
  }
  return app
})

export const tuiApp = (options: TuiAppOptions): Effect.Effect<TuiApp, never, BunServices.BunServices | Scope.Scope> =>
  start(options).pipe(Effect.orDie)
