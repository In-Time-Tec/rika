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
import { Deferred, Effect, Fiber, FileSystem, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { fileURLToPath } from "node:url"
import {
  credentialForRoute,
  interruptTrackedFibers,
  relayDatabaseLease,
  requiresRelay,
  settleTuiInitialization,
} from "../src/main"

test("holds one exclusive process lease for a Relay database", async () => {
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-relay-lease-" })
    const filename = `${workspace}/relay.db`
    const concurrent = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* relayDatabaseLease(filename)
        return yield* Effect.exit(Effect.scoped(relayDatabaseLease(filename)))
      }),
    )
    expect(String(concurrent)).toContain("is already in use by Rika process")
    yield* Effect.scoped(relayDatabaseLease(filename))
  })
  await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(BunServices.layer)))
})

test("classifies product-only commands without Relay and execution commands with Relay", () => {
  expect(requiresRelay({ _tag: "Config", action: "list" })).toBe(false)
  expect(requiresRelay({ _tag: "Doctor" })).toBe(false)
  expect(requiresRelay({ _tag: "Thread", action: "list" })).toBe(false)
  expect(requiresRelay({ _tag: "Thread", action: "continue", last: true })).toBe(true)
  expect(
    requiresRelay({
      _tag: "Run",
      prompt: [],
      ephemeral: false,
      streamJson: false,
      streamJsonInput: false,
      streamJsonThinking: false,
    }),
  ).toBe(true)
})

test("runs a product-only command under a held Relay lease without creating relay.db and rejects execution", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-relay-lazy-" })
        const relayDatabase = `${workspace}/relay.db`
        yield* relayDatabaseLease(relayDatabase)
        const run = (args: ReadonlyArray<string>) =>
          Effect.promise(async () => {
            const child = Bun.spawn(["bun", fileURLToPath(new URL("../src/main.ts", import.meta.url)), ...args], {
              cwd: fileURLToPath(new URL("../../..", import.meta.url)),
              env: {
                ...Bun.env,
                HOME: workspace,
                RIKA_DATABASE: `${workspace}/rika.db`,
                RIKA_RELAY_DATABASE: relayDatabase,
              },
              stdout: "pipe",
              stderr: "pipe",
            })
            const stdout = new Response(child.stdout).text()
            const stderr = new Response(child.stderr).text()
            return {
              code: await child.exited,
              stdout: await stdout,
              stderr: await stderr,
            }
          })
        const configList = yield* run(["config", "list"])
        if (configList.code !== 0) throw new Error(configList.stderr)
        expect(yield* fileSystem.exists(relayDatabase)).toBe(false)
        const execution = yield* run(["run", "blocked"])
        expect(execution.code).not.toBe(0)
        expect(execution.stderr).toContain("already in use by Rika process")
        expect(yield* fileSystem.exists(relayDatabase)).toBe(false)
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  )
}, 30_000)

test("selects only the credential named by each high and ultra main and Oracle gateway", () => {
  const openai = Redacted.make("openai-sentinel")
  const anthropic = Redacted.make("anthropic-sentinel")
  const credentials = { OPENAI_API_KEY: openai, ANTHROPIC_API_KEY: anthropic }
  const highMain = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "main")
  const highOracle = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const ultraMain = ConfigContract.resolveModelRoute(ConfigContract.defaults, "ultra", "main")
  const ultraOracle = ConfigContract.resolveModelRoute(ConfigContract.defaults, "ultra", "oracle")
  expect(credentialForRoute(highMain, credentials)).toBe(openai)
  expect(credentialForRoute(highOracle, credentials)).toBe(anthropic)
  expect(credentialForRoute(ultraMain, credentials)).toBe(anthropic)
  expect(credentialForRoute(ultraOracle, credentials)).toBe(openai)
})

test("awaits tracked fiber cleanup before releasing its enclosing lease", async () => {
  const events: Array<string> = []
  await Effect.runPromise(
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
    ),
  )
  expect(events).toEqual(["fiber-cleaned", "shutdown-resumed", "lease-released"])
})

test("awaits delayed TUI initialization and tears down its renderer before lease finalization", async () => {
  const events: Array<string> = []
  let resolveCreation: ((value: { readonly renderer: string }) => void) | undefined
  const creation = new Promise<{ readonly renderer: string }>((resolve) => {
    resolveCreation = resolve
  })
  let closed = false
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("lease-finalized")).pipe(Effect.asVoid))
        const initialization = settleTuiInitialization(
          creation,
          () => closed,
          async () => {
            events.push("renderer-stopped", "renderer-idle", "renderer-destroyed")
          },
        ).then((created) => {
          if (created !== undefined && !closed) events.push("post-close-work-started")
        })
        closed = true
        events.push("close-started")
        const close = Effect.promise(() => initialization).pipe(
          Effect.andThen(Effect.sync(() => events.push("shutdown-resumed"))),
          Effect.asVoid,
        )
        const closeFiber = yield* Effect.forkChild(close)
        yield* Effect.yieldNow
        expect(events).toEqual(["close-started"])
        resolveCreation?.({ renderer: "delayed" })
        yield* Fiber.join(closeFiber)
      }),
    ),
  )
  expect(events).toEqual([
    "close-started",
    "renderer-stopped",
    "renderer-idle",
    "renderer-destroyed",
    "shutdown-resumed",
    "lease-finalized",
  ])
})

test("drives bypassed recorded and incognito shell commands through Operation and native OpenTUI", async () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-shell-session-" })
      const filename = `${workspace}/rika.db`
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
        inspect: () => Effect.succeed(undefined),
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
                Effect.fail(new MediaView.MediaAnalysisError({ message: "Media analysis is unavailable" })),
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
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(Effect.provide(operationLayer))
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
        else if (
          event._tag !== "ThreadSelected" &&
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
      }).pipe(Effect.provide(Layer.merge(repositoryLayer, turnRepositoryLayer)))
      expect(persisted.threads).toHaveLength(1)
      expect(persisted.turns).toHaveLength(1)
      expect(persisted.turns[0]?.prompt).toContain("recorded-output")
      expect(persisted.turns[0]?.prompt).not.toContain("incognito-output")

      yield* Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("active"),
          threadId: Thread.ThreadId.make("shell-thread"),
          prompt: "active",
          now: 10,
        })
      }).pipe(Effect.provide(turnRepositoryLayer))
      yield* run("$ printf queued-output")
      const queued = yield* Effect.gen(function* () {
        const turns = yield* TurnRepository.Service
        return yield* turns.listQueued(Thread.ThreadId.make("shell-thread"))
      }).pipe(Effect.provide(turnRepositoryLayer))
      expect(queued).toHaveLength(1)
      expect(queued[0]?.prompt).toContain("queued-output")
      expect(setup.captureCharFrame()).toContain("queued-output")
    }),
  )
  await Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)))
})
