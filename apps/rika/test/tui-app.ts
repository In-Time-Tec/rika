import * as InteractiveSession from "@rika/product/interactive-session"
import * as TranscriptPage from "@rika/product/transcript-page"
import { MediaAnalysisError } from "@rika/coding-tools/media-view-service"
import { analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel } from "effect/unstable/ai"
import { ModelRegistry, TestModel } from "@rika/relay-execution/scripted-model-runtime"
import { createTestRenderer } from "@opentui/core/testing"
import { productLayer, Service } from "@rika/product/product-operation-service"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as RelayExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { Config, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema, Scope, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { interactiveTui } from "../src/interactive/process/process-loop"

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

const encodePrompt = Schema.encodeSync(Schema.UnknownFromJsonString)

const activityMarkers = ["Waiting", "Streaming", "Running 1 tool", "Thinking"] as const

export type Script = ReadonlyArray<Parameters<typeof TestModel.make>[0][number]>

export interface TuiAppLane {
  readonly when?: (prompt: string) => boolean
  readonly script: Script
}

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
}

const invalidateProjection = Effect.fn("TuiApp.invalidateProjection")(function* (turnId: Turn.TurnId) {
  const sql = yield* SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql`UPDATE rika_transcript_checkpoints
        SET projection_version = 2, model_phase = -1,
          usable_completion_sequence = NULL,
          oldest_cursor = NULL, checkpoint_cursor = NULL, cost_usd = NULL, usage_cursors_json = NULL,
          pricing_version = NULL
        WHERE turn_id = ${turnId}
        RETURNING turn_id`
      if (rows.length !== 1) return yield* Effect.die(`Transcript projection ${turnId} does not exist`)
      yield* sql`DELETE FROM rika_transcript_execution_checkpoints WHERE turn_id = ${turnId}`
      yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turnId}`
    }),
  )
})

export const makeProjectionsLegacy = Effect.fn("TuiApp.makeProjectionsLegacy")(function* (root: string) {
  const path = yield* Path.Path
  const database = Database.layer(path.join(root, "rika.db"))
  const repositories = Layer.mergeAll(ThreadRepository.layer, TurnRepository.layer, TranscriptRepository.layer).pipe(
    Layer.provide(database),
  )
  const context = yield* Layer.build(Layer.merge(repositories, database).pipe(Layer.provide(BunServices.layer)))
  const transcripts = Context.get(context, TranscriptRepository.Service)
  const turns = Context.get(context, TurnRepository.Service)
  const aged: Array<string> = []
  for (const thread of yield* Context.get(context, ThreadRepository.Service).list())
    for (const turn of yield* turns.list(thread.id)) {
      const projection = yield* transcripts.get(turn.id)
      if (projection === undefined) continue
      aged.push(String(turn.id))
      yield* invalidateProjection(turn.id).pipe(Effect.provide(context))
    }
  return aged
})

export type CapturedSpans = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

export interface TuiApp {
  readonly workspace: string
  readonly type: (text: string) => Promise<void>
  readonly pressEnter: () => void
  readonly pressEscape: () => void
  readonly pressArrow: (direction: "up" | "down" | "left" | "right") => void
  readonly pressKey: (key: string, modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean }) => void
  readonly clickText: (text: string) => Effect.Effect<void>
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
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  const root =
    options.root ??
    (yield* fileSystem.makeTempDirectoryScoped({ directory: temporaryDirectory, prefix: "rika-tui-app-" }))
  const workspace = path.join(root, "workspace")
  yield* fileSystem.makeDirectory(workspace, { recursive: true })
  for (const [name, content] of Object.entries(options.workspaceFiles ?? {})) {
    const target = path.join(workspace, name)
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true })
    yield* fileSystem.writeFileString(target, content)
  }
  const lanes = options.lanes ?? [{ script: options.script ?? [] }]
  const fixtures = yield* Effect.forEach(lanes, (lane) =>
    TestModel.make([...lane.script], {
      metadata: {
        provider: "test",
        model: "scripted",
        contextWindow: 1_000_000,
        maxOutput: 1_000_000,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    }),
  )
  const services = yield* Effect.forEach(fixtures, (built) =>
    Layer.build(built.layer).pipe(Effect.map((context) => Context.get(context, LanguageModel.LanguageModel))),
  )
  const selectLane = (prompt: unknown) => {
    const text = encodePrompt(prompt)
    const index = lanes.findIndex((lane) => lane.when !== undefined && lane.when(text))
    return services[index < 0 ? 0 : index]!
  }
  const routedModel: LanguageModel.Service = {
    ...services[0]!,
    streamText: ((request: Parameters<LanguageModel.Service["streamText"]>[0]) =>
      Stream.unwrap(
        Effect.sync(() => selectLane(request.prompt).streamText(request)),
      )) as LanguageModel.Service["streamText"],
  }
  const fixture = fixtures[0]!
  const registration = yield* ModelRegistry.registration({
    ...fixture.selection,
    layer: Layer.succeed(LanguageModel.LanguageModel, routedModel),
    ...(fixture.registration.metadata === undefined ? {} : { metadata: fixture.registration.metadata }),
  })
  const database = Database.layer(path.join(root, "rika.db"))
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
    Layer.provide(database),
    Layer.provide(BunServices.layer),
  )
  const usageRepositoryLayer = UsageRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const toolRuntimeLayer = (directory: string) =>
    ToolRuntime.layer(directory).pipe(
      Layer.provide(
        analyzerTestLayer(() => Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" }))),
      ),
      Layer.provide(
        Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
      Layer.provide(BunServices.layer),
      Layer.orDie,
    )
  const relayBackendLayer = RelayExecutionBackend.layer({
    filename: path.join(root, "execution.db"),
    workspace,
    registration,
    selection: fixture.selection,
    modelVariantPolicy: "fixed-selection",
    toolRuntimeLayer: toolRuntimeLayer(workspace),
  }).pipe(Layer.provide(BunServices.layer), Layer.orDie)
  const held = options.holdExecutionFollows
  const backendLayer = Layer.effect(
    ExecutionBackend.Service,
    Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const follow = backend.follow
      return ExecutionBackend.Service.of({
        ...backend,
        ...(follow === undefined
          ? {}
          : {
              follow: (turnId, afterCursor, onEvent, reference, eventScope) =>
                (held === undefined ? Effect.void : Deferred.await(held)).pipe(
                  Effect.andThen(Effect.suspend(() => follow(turnId, afterCursor, onEvent, reference, eventScope))),
                ),
            }),
      })
    }),
  ).pipe(Layer.provide(relayBackendLayer))
  const setup = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30, exitOnCtrlC: false }),
    ),
    (created) => Effect.sync(() => created.renderer.destroy()).pipe(Effect.ignore),
  )
  const terminalTitles: Array<string> = []
  let nextThread = options.idStart ?? 0
  let nextTurn = options.idStart ?? 0
  let session: InteractiveSession | undefined
  const reloadLoaded = yield* Deferred.make<void>()
  const runSync = Effect.runSyncWith(yield* Effect.context<never>())
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
    toolRuntimeLayer,
    defaultWorkspace: workspace,
    makeThreadId: Effect.sync(() => Thread.ThreadId.make(`tui-thread-${nextThread++}`)),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`tui-turn-${nextTurn++}`)),
    resolveExecutionRoute: (mode) =>
      Effect.sync(() => {
        const { title: _title, ...pin } = ExecutionRouteSnapshot.testExecutionRoute(mode)
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
  const operation = Context.get(yield* Layer.buildWithScope(operationLayer, yield* Effect.scope), Service)
  const transcripts =
    options.inspectTranscript === true
      ? Context.get(
          yield* Layer.buildWithScope(transcriptRepositoryLayer, yield* Effect.scope),
          TranscriptRepository.Service,
        )
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
    Fiber.interrupt(operationFiber).pipe(Effect.andThen(Fiber.await(operationFiber)), Effect.asVoid),
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
  const settled = waitFor((captured) => !activityMarkers.some((marker) => captured.includes(marker)), 60_000)
  const app: TuiApp = {
    workspace,
    type: (text) => setup.mockInput.typeText(text),
    pressEnter: () => setup.mockInput.pressEnter(),
    pressEscape: () => setup.mockInput.pressEscape(),
    pressArrow: (direction) => setup.mockInput.pressArrow(direction),
    pressKey: (key, modifiers) =>
      modifiers?.alt === true ? setup.mockInput.pressKey(`\u001b${key}`) : setup.mockInput.pressKey(key, modifiers),
    clickText: (text) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => setup.flush())
        const lines = frame().split("\n")
        const y = lines.findIndex((line) => line.includes(text))
        const x = y < 0 ? -1 : lines[y]!.indexOf(text)
        if (x < 0 || y < 0) return yield* Effect.die(`tui-app could not click missing text: ${text}`)
        yield* Effect.promise(() => setup.mockMouse.click(x, y))
      }),
    frame,
    spans: () => setup.captureSpans(),
    transcript: (turnId) => transcripts?.get(turnId) ?? Effect.die("TUI transcript inspection was not requested"),
    waitFrame: (marker, timeoutMillis = 60_000) => waitFor((captured) => captured.includes(marker), timeoutMillis),
    waitFrameMatch: (predicate, timeoutMillis = 60_000) => waitFor(predicate, timeoutMillis),
    waitCost: waitFor((captured) => /\$[0-9]/u.test(captured), 60_000),
    waitGone: (marker, timeoutMillis = 60_000) => waitFor((captured) => !captured.includes(marker), timeoutMillis),
    waitTerminalTitle: (predicate, timeoutMillis = 60_000) => waitTerminalTitle(predicate, timeoutMillis),
    settled,
    reload: Effect.gen(function* () {
      yield* session?.reopenThread(100).pipe(Effect.orDie) ?? Effect.die("TUI session is unavailable")
      yield* Deferred.await(reloadLoaded)
    }),
    waitModelRequests: (count) => fixture.awaitRequests(count).pipe(Effect.asVoid),
    close: () => setup.mockInput.pressCtrlC(),
    done: Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie),
    quit: Effect.gen(function* () {
      yield* settled
      setup.mockInput.pressCtrlC()
      yield* Fiber.join(operationFiber).pipe(Effect.asVoid, Effect.orDie)
    }),
  }
  yield* app.waitFrame(options.initialThreadId === undefined ? "Welcome to Rika" : "medium")
  return app
})
