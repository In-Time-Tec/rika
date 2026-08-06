import * as InteractiveSession from "@rika/product/interactive-session"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { productLayer, Service } from "@rika/product/product-operation-service"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { Config, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Scope } from "effect"
import { performance } from "node:perf_hooks"
import { interactiveTui } from "../src/interactive/process/interactive-process-loop"
import {
  makeTuiAppRepositoryLayers,
  seedHistoricalTranscript,
  type HistoricalTranscriptFixture,
} from "./tui-app-repositories"
import type { Script, TuiAppLane } from "./tui-app-model"
import { tuiToolRuntimeLayer } from "./tui-app-tool-runtime"
import { layer as executionGatewayLayer } from "./tui-app-execution-gateway"

const activityMarkers = ["Waiting", "Streaming", "Running 1 tool", "Thinking"] as const
const currentWallTime = () => performance.now()

type SessionEvent = Parameters<Parameters<InteractiveSession.InteractiveSession["events"]>[0]>[0]

export interface TuiAppOptions {
  readonly script?: Script
  readonly lanes?: ReadonlyArray<TuiAppLane>
  readonly root?: string
  readonly initialThreadId?: string
  readonly idStart?: number
  readonly inspectTranscript?: boolean
  readonly workspaceFiles?: Readonly<Record<string, string>>
  readonly width?: number
  readonly height?: number
  readonly holdExecutionFollows?: Deferred.Deferred<void>
  readonly mapInteractiveEvent?: (event: SessionEvent) => SessionEvent
  readonly historicalTranscriptFixture?: HistoricalTranscriptFixture
}

export type CapturedSpans = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

export interface TuiApp {
  readonly workspace: string
  readonly type: (text: string) => Promise<void>
  readonly pressEnter: () => void
  readonly pressEscape: () => void
  readonly pressArrow: (direction: "up" | "down" | "left" | "right") => void
  readonly pressKey: (key: string, modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean }) => void
  readonly pressPageUp: Effect.Effect<void>
  readonly clickText: (text: string) => Effect.Effect<void>
  readonly clickComposer: Effect.Effect<void>
  readonly frame: () => string
  readonly spans: () => CapturedSpans
  readonly transcript: (
    turnId: Turn.TurnId,
  ) => Effect.Effect<TranscriptPage.Projection | undefined, TranscriptRepository.RepositoryError>
  readonly waitFrame: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitFrameMatch: (predicate: (frame: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitCost: Effect.Effect<string>
  readonly waitGone: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitTerminalTitle: (predicate: (title: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly settled: Effect.Effect<string>
  readonly reload: Effect.Effect<void>
  readonly waitModelRequests: (count: number) => Effect.Effect<void>
  readonly close: () => void
  readonly done: Effect.Effect<void>
  readonly quit: Effect.Effect<void>
}

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

export const tuiApp = Effect.fn("TuiApp.start")(function* (options: TuiAppOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const context = yield* Effect.context<never>()
  const runFork = Effect.runForkWith(context)
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  const root =
    options.root ??
    (yield* fileSystem.makeTempDirectoryScoped({ directory: temporaryDirectory, prefix: "rika-tui-app-" }))
  const workspace = path.join(root, "workspace")
  const resourceScope = yield* Scope.make()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      runFork(Scope.close(resourceScope, Exit.void))
    }),
  )
  yield* fileSystem.makeDirectory(workspace, { recursive: true })
  for (const [name, content] of Object.entries(options.workspaceFiles ?? {})) {
    const target = path.join(workspace, name)
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
    yield* fileSystem.writeFileString(target, content)
  }
  const lanes = options.lanes ?? [{ script: options.script ?? [] }]
  let modelRequests = 0
  const awaitModelRequests = (count: number): Effect.Effect<void> =>
    Effect.suspend(() =>
      modelRequests >= count ? Effect.void : Effect.sleep("1 millis").pipe(Effect.andThen(awaitModelRequests(count))),
    )
  const { repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer, usageRepositoryLayer } =
    makeTuiAppRepositoryLayers(path.join(root, "rika.db"))
  if (options.historicalTranscriptFixture !== undefined) {
    const historicalRepositories = yield* Layer.buildWithScope(
      Layer.mergeAll(repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer),
      resourceScope,
    )
    yield* seedHistoricalTranscript(options.historicalTranscriptFixture, workspace).pipe(
      Effect.provide(historicalRepositories),
    )
  }
  const toolRuntime = Context.get(
    yield* Layer.buildWithScope(tuiToolRuntimeLayer(workspace), resourceScope),
    ToolRuntime.Service,
  )
  const backendLayer = executionGatewayLayer({
    lanes,
    toolRuntime,
    scope: resourceScope,
    ...(options.holdExecutionFollows === undefined ? {} : { holdChildEvents: options.holdExecutionFollows }),
    modelRequested: () => {
      modelRequests += 1
    },
  })
  const setup = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30, exitOnCtrlC: false }),
    ),
    (created) => Effect.sync(() => created.renderer.destroy()).pipe(Effect.ignore),
  )
  const terminalTitles: Array<string> = []
  let nextThread = options.idStart ?? 0
  let nextTurn = options.idStart ?? 0
  let session: InteractiveSession.InteractiveSession | undefined
  const reloadLoaded = yield* Deferred.make<void>()
  const historicalFixtureLoaded = yield* Deferred.make<void>()
  const runSync = Effect.runSyncWith(context)
  const runInteractive = interactiveTui({
    makeRenderer: () => Promise.resolve(setup.renderer),
    writeTerminalTitle: (sequence) => terminalTitles.push(sequence.slice(4, -1)),
  })
  const operationLayer = productLayer({
    repositoryLayer,
    turnRepositoryLayer,
    transcriptRepositoryLayer,
    usageRepositoryLayer,
    backendLayer,
    toolRuntimeLayer: () => Layer.succeed(ToolRuntime.Service, toolRuntime),
    defaultWorkspace: workspace,
    makeThreadId: Effect.sync(() => Thread.ThreadId.make(`tui-thread-${nextThread++}`)),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`tui-turn-${nextTurn++}`)),
    resolveExecutionRoute: (mode) => Effect.sync(() => ExecutionRouteSnapshot.testExecutionRoute(mode)),
    interactive: (settings, current) => {
      session = current
      return runInteractive(settings, {
        ...current,
        events: (dispatch) =>
          current.events((event) => {
            const delivered = options.mapInteractiveEvent?.(event) ?? event
            dispatch(delivered)
            if (delivered._tag === "SelectionLoaded" && delivered.selectionEpoch === 100)
              runSync(Deferred.succeed(reloadLoaded, undefined))
            if (delivered._tag === "SelectionLoaded" && delivered.selectionEpoch === 90)
              runSync(Deferred.succeed(historicalFixtureLoaded, undefined))
          }),
      })
    },
  })
  const operation = Context.get(yield* Layer.buildWithScope(operationLayer, resourceScope), Service)
  const transcripts =
    options.inspectTranscript === true
      ? Context.get(yield* Layer.buildWithScope(transcriptRepositoryLayer, resourceScope), TranscriptRepository.Service)
      : undefined
  const operationFiber = yield* Effect.forkChild(
    operation
      .run({
        _tag: "Interactive",
        prompt: [],
        workspace,
        ...(options.initialThreadId === undefined ? {} : { threadId: options.initialThreadId }),
        ephemeral: false,
      })
      .pipe(Effect.orDie),
  )
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      runFork(Fiber.interrupt(operationFiber))
    }),
  )
  const frame = () => setup.captureCharFrame()
  const waitFor = (predicate: (frame: string) => boolean, timeoutMillis: number) =>
    Effect.gen(function* () {
      const started = currentWallTime()
      for (;;) {
        yield* Effect.promise(() => setup.flush())
        const captured = frame()
        if (predicate(captured)) return captured
        if (currentWallTime() - started >= timeoutMillis) {
          return yield* Effect.die(`tui-app timed out waiting on frame\n${captured}`)
        }
        yield* Effect.sleep("20 millis")
      }
    })
  const waitTerminalTitle = (predicate: (title: string) => boolean, timeoutMillis: number) =>
    Effect.gen(function* () {
      const started = currentWallTime()
      for (;;) {
        const title = terminalTitles.at(-1)
        if (title !== undefined && predicate(title)) return title
        if (currentWallTime() - started >= timeoutMillis)
          return yield* Effect.die(`tui-app timed out waiting on terminal title\n${title ?? "<unset>"}`)
        yield* Effect.sleep("20 millis")
      }
    })
  const settled = waitFor((captured) => !activityMarkers.some((marker) => captured.includes(marker)), 10_000)
  const app: TuiApp = {
    workspace,
    type: (text) => setup.mockInput.typeText(text),
    pressEnter: () => setup.mockInput.pressEnter(),
    pressEscape: () => setup.mockInput.pressEscape(),
    pressArrow: (direction) => setup.mockInput.pressArrow(direction),
    pressKey: (key, modifiers) =>
      modifiers?.alt === true ? setup.mockInput.pressKey(`\u001b${key}`) : setup.mockInput.pressKey(key, modifiers),
    pressPageUp: Effect.gen(function* () {
      setup.mockInput.pressKey("\u001b[5~")
      yield* Effect.promise(() => setup.flush())
      yield* Effect.yieldNow
      yield* Effect.promise(() => setup.flush())
    }).pipe(Effect.asVoid),
    clickText: (text) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => setup.flush())
        const lines = frame().split("\n")
        const y = lines.findIndex((line) => line.includes(text))
        const x = y < 0 ? -1 : lines[y]!.indexOf(text)
        if (x < 0 || y < 0) return yield* Effect.die(`tui-app could not click missing text: ${text}`)
        yield* Effect.promise(() => setup.mockMouse.click(x, y))
      }),
    clickComposer: Effect.gen(function* () {
      yield* Effect.promise(() => setup.flush())
      yield* Effect.promise(() => setup.mockMouse.click(2, (options.height ?? 30) - 2))
    }).pipe(Effect.asVoid),
    frame,
    spans: () => setup.captureSpans(),
    transcript: (turnId) => transcripts?.get(turnId) ?? Effect.die("TUI transcript inspection was not requested"),
    waitFrame: (marker, timeoutMillis = 10_000) => waitFor((captured) => captured.includes(marker), timeoutMillis),
    waitFrameMatch: (predicate, timeoutMillis = 10_000) => waitFor(predicate, timeoutMillis),
    waitCost: waitFor((captured) => /\$[0-9]/u.test(captured), 10_000),
    waitGone: (marker, timeoutMillis = 10_000) => waitFor((captured) => !captured.includes(marker), timeoutMillis),
    waitTerminalTitle: (predicate, timeoutMillis = 10_000) => waitTerminalTitle(predicate, timeoutMillis),
    settled,
    reload: Effect.gen(function* () {
      yield* session?.reopenThread(100).pipe(Effect.orDie) ?? Effect.die("TUI session is unavailable")
      yield* Deferred.await(reloadLoaded)
    }),
    waitModelRequests: awaitModelRequests,
    close: () => setup.mockInput.pressCtrlC(),
    done: Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie),
    quit: Effect.gen(function* () {
      yield* settled
      setup.mockInput.pressCtrlC()
      yield* Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie)
    }),
  }
  yield* app.waitFrame("medium")
  if (options.historicalTranscriptFixture !== undefined) {
    const current = session ?? (yield* Effect.die("TUI session is unavailable"))
    yield* current.selectThread(options.historicalTranscriptFixture.threadId, 90).pipe(Effect.orDie)
    yield* Deferred.await(historicalFixtureLoaded)
  }
  return app
})
