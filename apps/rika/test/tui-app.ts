import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { createTestRenderer } from "@opentui/core/testing"
import { Operation } from "@rika/app"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as RelayExecutionBackend from "@rika/runtime/relay"
import { MediaView, ReadWebPage, Runtime as ToolRuntime, WebSearch } from "@rika/tools"
import { Config, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Scope } from "effect"
import { AiError } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { interactiveTui } from "../src/main"

export const model = {
  text: (text: string, delayMs?: number) =>
    TestModel.turn([TestModel.text(text)], delayMs === undefined ? {} : { delay: `${delayMs} millis` }),
  turn: TestModel.turn,
  part: TestModel.text,
  reasoning: TestModel.reasoning,
  toolCall: (name: string, params: unknown, id?: string) =>
    TestModel.toolCall(name, params, id === undefined ? {} : { id }),
  failure: (description: string) =>
    TestModel.failure(
      AiError.make({
        module: "TestModel",
        method: "streamText",
        reason: AiError.UnknownError.make({ description }),
      }),
    ),
}

export interface TuiAppOptions {
  readonly script: ReadonlyArray<Parameters<typeof TestModel.make>[0][number]>
  readonly shellPermission?: "allow" | "ask" | "deny"
  readonly toolNeedsApproval?: (name: string) => boolean
  readonly workspaceFiles?: Readonly<Record<string, string>>
  readonly width?: number
  readonly height?: number
}

export type CapturedSpans = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

export interface TuiApp {
  readonly workspace: string
  readonly type: (text: string) => Promise<void>
  readonly pressEnter: () => void
  readonly pressEscape: () => void
  readonly pressArrow: (direction: "up" | "down" | "left" | "right") => void
  readonly pressKey: (key: string, modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean }) => void
  readonly frame: () => string
  readonly spans: () => CapturedSpans
  readonly waitFrame: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitGone: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitTerminalTitle: (predicate: (title: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly reload: Effect.Effect<void>
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
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  const root = yield* fileSystem.makeTempDirectoryScoped({ directory: temporaryDirectory, prefix: "rika-tui-app-" })
  const workspace = path.join(root, "workspace")
  yield* fileSystem.makeDirectory(workspace)
  for (const [name, content] of Object.entries(options.workspaceFiles ?? {})) {
    const target = path.join(workspace, name)
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
    yield* fileSystem.writeFileString(target, content)
  }
  const fixture = yield* TestModel.make([...options.script])
  const database = Database.layer(path.join(root, "rika.db"))
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const toolRuntimeLayer = (directory: string) =>
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
    )
  const backendLayer = RelayExecutionBackend.layer({
    filename: path.join(root, "relay.db"),
    workspace,
    registration: fixture.registration,
    selection: fixture.selection,
    modelVariantPolicy: "fixed-selection",
    toolRuntimeLayer: toolRuntimeLayer(workspace),
    toolNeedsApproval: options.toolNeedsApproval ?? (() => false),
    permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
  }).pipe(Layer.provide(BunServices.layer), Layer.orDie)
  const setup = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30, exitOnCtrlC: false }),
    ),
    (created) => Effect.sync(() => created.renderer.destroy()).pipe(Effect.ignore),
  )
  const terminalTitles: Array<string> = []
  let nextThread = 0
  let nextTurn = 0
  let session: Operation.InteractiveSession | undefined
  const reloadLoaded = yield* Deferred.make<void>()
  const runSync = Effect.runSyncWith(yield* Effect.context<never>())
  const runInteractive = interactiveTui({
    makeRenderer: () => Promise.resolve(setup.renderer),
    writeTerminalTitle: (sequence) => terminalTitles.push(sequence.slice(4, -1)),
  })
  const operationLayer = Operation.productLayer({
    repositoryLayer,
    turnRepositoryLayer,
    backendLayer,
    toolRuntimeLayer,
    defaultWorkspace: workspace,
    shellPermission: options.shellPermission ?? "allow",
    makeThreadId: Effect.sync(() => Thread.ThreadId.make(`tui-thread-${nextThread++}`)),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`tui-turn-${nextTurn++}`)),
    resolveExecutionRoute: (mode) =>
      Effect.sync(() => {
        const { title: _title, ...pin } = Turn.testExecutionRoute(mode)
        return pin
      }),
    interactive: (settings, current) => {
      session = current
      return runInteractive(settings, {
        ...current,
        events: (dispatch) =>
          current.events((event) => {
            dispatch(event)
            if (event._tag === "SelectionLoaded" && event.selectionEpoch === 100)
              runSync(Deferred.succeed(reloadLoaded, undefined))
          }),
      })
    },
  })
  const operation = Context.get(yield* Layer.buildWithScope(operationLayer, yield* Effect.scope), Operation.Service)
  const operationFiber = yield* Effect.forkChild(
    operation.run({ _tag: "Interactive", prompt: [], workspace, ephemeral: false }).pipe(Effect.orDie),
  )
  const frame = () => setup.captureCharFrame()
  const waitFor = (predicate: (frame: string) => boolean, timeoutMillis: number) =>
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      for (;;) {
        yield* Effect.promise(() => setup.flush())
        const captured = frame()
        if (predicate(captured)) return captured
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= timeoutMillis) {
          return yield* Effect.die(`tui-app timed out waiting on frame\n${captured}`)
        }
        yield* Effect.sleep("20 millis")
      }
    })
  const waitTerminalTitle = (predicate: (title: string) => boolean, timeoutMillis: number) =>
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      for (;;) {
        const title = terminalTitles.at(-1)
        if (title !== undefined && predicate(title)) return title
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= timeoutMillis)
          return yield* Effect.die(`tui-app timed out waiting on terminal title\n${title ?? "<unset>"}`)
        yield* Effect.sleep("20 millis")
      }
    })
  const app: TuiApp = {
    workspace,
    type: (text) => setup.mockInput.typeText(text),
    pressEnter: () => setup.mockInput.pressEnter(),
    pressEscape: () => setup.mockInput.pressEscape(),
    pressArrow: (direction) => setup.mockInput.pressArrow(direction),
    pressKey: (key, modifiers) =>
      modifiers?.alt === true ? setup.mockInput.pressKey(`\u001b${key}`) : setup.mockInput.pressKey(key, modifiers),
    frame,
    spans: () => setup.captureSpans(),
    waitFrame: (marker, timeoutMillis = 60_000) => waitFor((captured) => captured.includes(marker), timeoutMillis),
    waitGone: (marker, timeoutMillis = 60_000) => waitFor((captured) => !captured.includes(marker), timeoutMillis),
    waitTerminalTitle: (predicate, timeoutMillis = 60_000) => waitTerminalTitle(predicate, timeoutMillis),
    reload: Effect.gen(function* () {
      yield* session?.reopenThread(100).pipe(Effect.orDie) ?? Effect.die("TUI session is unavailable")
      yield* Deferred.await(reloadLoaded)
    }),
    close: () => setup.mockInput.pressCtrlC(),
    done: Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie),
    quit: Effect.gen(function* () {
      for (const activity of ["Waiting", "Streaming", "Running 1 tool", "Thinking"]) {
        yield* waitFor((captured) => !captured.includes(activity), 60_000)
      }
      setup.mockInput.pressCtrlC()
      yield* Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie)
    }),
  }
  yield* app.waitFrame("Welcome to Rika")
  return app
})
