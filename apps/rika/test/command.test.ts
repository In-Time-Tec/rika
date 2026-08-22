import * as BunServices from "@effect/platform-bun/BunServices"
import { OperationUnavailable } from "@rika/product/product-operation"
import { Service } from "@rika/product/product-operation-service"
import type { Input as ProductInput } from "@rika/product/product-operation"
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Path, Ref, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import { run as runClient } from "../src/client/client-process"
import { cleanInteractiveRuntimeExit } from "../src/client/client-process"
import { clientProcessExitCode } from "../src/client/client-process-exit"
import { parseJsonLines, readStreamInput } from "../src/command/root/noninteractive-run-command"
import { run } from "../src/command/root/rika-command"
import * as HostedCommand from "../src/command/root/hosted-command-dispatch"
import * as LocalRunnerCommand from "../src/command/root/local-runner-command"
import { localExecutorProcessRole, tuiControllerProcessRole } from "../src/private-runtime-role"

const workspace = process.cwd()
type Input = ProductInput | HostedCommand.Input | LocalRunnerCommand.Input

const testLayer = (calls: Ref.Ref<ReadonlyArray<Input>>) =>
  Layer.mergeAll(
    Layer.succeed(
      Service,
      Service.of({
        run: Effect.fn("CommandTest.run")(function* (input) {
          yield* Ref.update(calls, (current) => [...current, input])
        }),
      }),
    ),
    Layer.succeed(
      HostedCommand.Service,
      HostedCommand.Service.of({
        run: Effect.fn("CommandTest.runHosted")(function* (input) {
          yield* Ref.update(calls, (current) => [...current, input])
        }),
      }),
    ),
    Layer.succeed(
      LocalRunnerCommand.Service,
      LocalRunnerCommand.Service.of({
        run: Effect.fn("CommandTest.runLocalRunner")(function* (input) {
          yield* Ref.update(calls, (current) => [...current, input])
        }),
      }),
    ),
  )

it("maps pure client interruption to success without masking failures", () => {
  expect(clientProcessExitCode({ exit: Exit.interrupt(1), interruptedBySigint: true })).toBe(0)
  expect(clientProcessExitCode({ exit: Exit.interrupt(1), interruptedBySigint: false })).toBe(130)
  expect(clientProcessExitCode({ exit: Exit.succeed(undefined), interruptedBySigint: false })).toBe(0)
  expect(clientProcessExitCode({ exit: Exit.fail("real failure"), interruptedBySigint: true })).toBe(1)
})

it("accepts only successful and SIGINT-convention interactive runtime exits", () => {
  expect(cleanInteractiveRuntimeExit(0)).toBe(true)
  expect(cleanInteractiveRuntimeExit(130)).toBe(true)
  expect(cleanInteractiveRuntimeExit(1)).toBe(false)
  expect(cleanInteractiveRuntimeExit(143)).toBe(false)
})

const execute = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>): Effect.Effect<A, E, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const context = yield* Layer.buildWithScope(layer, scope)
      return yield* Effect.provide(effect, context)
    }),
  )

const capture = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, testLayer(calls))
    yield* execute(run(argv), layer)
    return yield* Ref.get(calls)
  })

const failsWithoutDispatch = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, testLayer(calls))
    const exit = yield* Effect.exit(execute(run(argv), layer))
    expect(exit._tag).toBe("Failure")
    expect(yield* Ref.get(calls)).toEqual([])
  })

it("parses JSONL prompt input and reports malformed physical source lines", () => {
  expect(parseJsonLines('\n"one"\n  \n{"prompt":"two"}\n')).toEqual(["one", "two"])
  expect(() => parseJsonLines('\n"one"\n  \nnot-json\n')).toThrow("Invalid JSON on stdin line 4")
  expect(() => parseJsonLines("\n\n42")).toThrow("JSON on stdin line 3 must be a string or prompt object")
})

const streamInput = (prompt: ReadonlyArray<string> = []) => ({
  _tag: "Run" as const,
  prompt,
  ephemeral: false,
  streamJson: true,
  streamJsonInput: true,
  streamJsonThinking: false,
})

const validChunks = () => Stream.toAsyncIterable(Stream.make('"one"\n', '{"prompt":"two"}\n'))

it.effect("reads valid, invalid, and empty JSONL stream input", () =>
  Effect.gen(function* () {
    expect((yield* readStreamInput(streamInput(), validChunks())).prompt).toEqual(["one", "two"])
    expect((yield* readStreamInput(streamInput(), Stream.toAsyncIterable(Stream.empty))).prompt).toEqual([])
    expect(
      (yield* Effect.result(readStreamInput(streamInput(), Stream.toAsyncIterable(Stream.make("bad")))))._tag,
    ).toBe("Failure")
    expect((yield* readStreamInput(streamInput(["existing"]), validChunks())).prompt).toEqual(["existing"])
  }),
)

it.effect("maps stdin failures and dispatch failures", () =>
  Effect.gen(function* () {
    const broken = Stream.toAsyncIterable(Stream.fail(new Error("stdin unavailable")))
    const read = yield* Effect.result(readStreamInput(streamInput(), broken))
    expect(read._tag === "Failure" && read.failure.message).toContain("Unable to read JSON input")
    const layer = Layer.mergeAll(
      BunServices.layer,
      FetchHttpClient.layer,
      TestConsole.layer,
      Layer.succeed(
        Service,
        Service.of({
          run: (_input): Effect.Effect<void, OperationUnavailable> =>
            Effect.fail(OperationUnavailable.make({ operation: "Doctor", message: "dispatch failed" })),
        }),
      ),
    )
    expect(
      (yield* Effect.exit(
        execute(run([tuiControllerProcessRole]).pipe(Effect.mapError((error) => String(error))), layer),
      ))._tag,
    ).toBe("Failure")
  }),
)

it.effect("renders help without dispatching an operation", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, testLayer(calls))
    const output = yield* execute(
      Effect.gen(function* () {
        yield* run(["--help"])
        return yield* TestConsole.logLines
      }),
      layer,
    )
    expect(output.join("\n")).toContain("Hosted durable coding agent")
    expect(output.join("\n")).toContain("diagnostics")
    expect(output.join("\n")).not.toContain(tuiControllerProcessRole)
    expect(output.join("\n")).not.toContain(localExecutorProcessRole)
    yield* execute(run(["diagnostics", "--help"]), layer)
    expect((yield* TestConsole.logLines).join("\n")).toContain("performance")
    expect(yield* Ref.get(calls)).toEqual([])
  }),
)

it.effect("renders client help without creating the configured data root", () =>
  execute(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-client-help-" })
        const dataRoot = path.join(root, "nested")
        const provider = ConfigProvider.fromEnv({
          env: {
            HOME: path.join(root, "home"),
          },
        })
        yield* runClient(["--help"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
        yield* runClient(["auth", "--help"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
        yield* runClient(["credential", "--help"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
        yield* runClient(["org", "--help"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
        yield* runClient(["thread", "new", "--help"]).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
        )
        yield* runClient(["auth", "status", "--json"]).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
        )
        expect((yield* TestConsole.logLines).join("\n")).toContain('{"authenticated":false}')
        expect(yield* fileSystem.exists(dataRoot)).toBe(false)
      }),
    ),
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer),
  ),
)

it.effect("inspects and exports malformed crash evidence without dispatching an operation", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, testLayer(calls))
    yield* execute(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-diagnostics-command-" })
          const dataRoot = path.join(root, "home", ".config", "rika")
          const diagnostics = path.join(dataRoot, "diagnostics")
          const destination = path.join(root, "export")
          yield* fileSystem.makeDirectory(diagnostics, { recursive: true, mode: 0o700 })
          yield* fileSystem.writeFileString(path.join(diagnostics, "server-crash.open.jsonl"), '{"partial":', {
            mode: 0o600,
          })
          const provider = ConfigProvider.fromEnv({
            env: {
              HOME: path.join(root, "home"),
            },
          })
          yield* run(["diagnostics", "path"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
          yield* run(["diagnostics", "status"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
          yield* run(["diagnostics", "export", destination]).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, provider),
          )
          const output = yield* TestConsole.logLines
          expect(output).toContain(yield* fileSystem.realPath(diagnostics))
          expect(output).toContain("1 log file, 11 bytes")
          expect(yield* fileSystem.readFileString(path.join(destination, "server-crash.open.jsonl"))).toBe(
            '{"partial":',
          )
        }),
      ),
      layer,
    )
    expect(yield* Ref.get(calls)).toEqual([])
  }),
)

it.effect("updates the install in this process instead of dispatching to the server", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, testLayer(calls))
    yield* execute(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-update-command-" })
          const provider = ConfigProvider.fromEnv({ env: { RIKA_INSTALL_ROOT: path.join(root, "current") } })
          const exit = yield* Effect.exit(
            run(["update"]).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)),
          )
          expect(exit._tag).toBe("Failure")
        }),
      ),
      layer,
    )
    expect(yield* Ref.get(calls)).toEqual([])
  }),
)

it.effect("rejects stream input without stream output", () =>
  Effect.gen(function* () {
    yield* failsWithoutDispatch(["run", "--stream-json-input", "hello"])
    yield* failsWithoutDispatch(["run", "--stream-json-thinking", "hello"])
    yield* failsWithoutDispatch(["--stream-json"])
  }),
)

it.effect("exposes only the supported model credential providers", () =>
  Effect.gen(function* () {
    yield* failsWithoutDispatch(["credential", "set", "chatgpt"])
    yield* failsWithoutDispatch(["credential", "list", "codex"])
  }),
)

it.effect("requires a hosted Thread for non-interactive execution", () =>
  Effect.gen(function* () {
    yield* failsWithoutDispatch(["run", "hello"])
    yield* failsWithoutDispatch(["--execute", "hello"])
    yield* failsWithoutDispatch(["run", "hello", "--thread", "thread-1", "--workspace", "."])
    yield* failsWithoutDispatch(["run", "hello", "--thread", "thread-1", "--ephemeral"])
  }),
)

it.effect("routes headless runner mode and keeps remote Thread creation opt in", () =>
  Effect.gen(function* () {
    expect(yield* capture(["--no-tui"])).toEqual([{}])
    expect(yield* capture(["--no-tui", "--workspace", ".", "--allow-remote-thread-creation"])).toEqual([
      { workspace, remoteThreadCreation: "allowed" },
    ])
    expect(yield* capture(["--no-tui", "--deny-remote-thread-creation"])).toEqual([{ remoteThreadCreation: "denied" }])
    yield* failsWithoutDispatch(["--allow-remote-thread-creation"])
    yield* failsWithoutDispatch(["--no-tui", "--allow-remote-thread-creation", "--deny-remote-thread-creation"])
  }),
)

it.effect("dispatches interactive inputs and hosted non-interactive execution", () =>
  Effect.gen(function* () {
    expect(yield* capture([tuiControllerProcessRole])).toEqual([{ _tag: "Interactive", prompt: [], ephemeral: false }])
    expect(yield* capture([localExecutorProcessRole, "--no-tui", "--workspace", "."])).toEqual([{ workspace }])
    expect(yield* capture(["hello", "world", "--mode", "high", "--ephemeral"])).toEqual([
      { _tag: "Interactive", prompt: ["hello", "world"], mode: "high", ephemeral: true },
    ])
    expect(yield* capture(["-x", "hello", "--thread", "thread-1", "--mode", "high"])).toEqual([
      {
        _tag: "RemoteRun",
        threadId: "thread-1",
        request: { prompt: ["hello"], mode: "high" },
      },
    ])
    expect(yield* capture(["run", "hello", "--mode", "low", "--thread", "thread-2"])).toEqual([
      {
        _tag: "RemoteRun",
        threadId: "thread-2",
        request: { prompt: ["hello"], mode: "low" },
      },
    ])
    expect(yield* capture(["hello", "--workspace", ".", "--thread", "thread-2"])).toEqual([
      { _tag: "Interactive", prompt: ["hello"], workspace, threadId: "thread-2", ephemeral: false },
    ])
  }),
)

it.effect("rejects an invalid interactive workspace before dispatch", () =>
  failsWithoutDispatch(["--workspace", `${workspace}/missing-interactive-workspace`]),
)

it.effect("creates and continues hosted Threads without a local Thread operation", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Input]> = [
      [["thread", "new"], { _tag: "RemoteThread", action: "new" }],
      [["thread", "continue", "--last"], { _tag: "Interactive", prompt: [], last: true, ephemeral: false }],
      [["thread", "continue", "a"], { _tag: "Interactive", prompt: [], threadId: "a", ephemeral: false }],
    ]
    for (const [argv, expected] of cases) expect(yield* capture(argv)).toEqual([expected])
  }),
)

it.effect("rejects invalid thread relationships", () =>
  Effect.gen(function* () {
    yield* failsWithoutDispatch(["thread", "continue"])
    yield* failsWithoutDispatch(["thread", "continue", "--last", "a"])
    yield* failsWithoutDispatch(["thread", "continue", "a", "b"])
    yield* failsWithoutDispatch(["thread", "new", "--remote"])
  }),
)

it.effect("renders version and branch help without dispatching", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, testLayer(calls))
    const output = yield* execute(
      Effect.gen(function* () {
        yield* run(["version"])
        yield* run(["thread", "--help"])
        return yield* TestConsole.logLines
      }),
      layer,
    )
    expect(output.join("\n")).toContain("0.0.0")
    expect(output.join("\n")).toContain("Create or continue hosted durable Threads")
    expect(yield* Ref.get(calls)).toEqual([])
  }),
)
