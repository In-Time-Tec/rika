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

const workspace = process.cwd()
type Input = ProductInput | HostedCommand.Input

const testLayer = (calls: Ref.Ref<ReadonlyArray<Input>>) =>
  Layer.merge(
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
      (yield* Effect.exit(execute(run(["doctor"]).pipe(Effect.mapError((error) => String(error))), layer)))._tag,
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
    expect(output.join("\n")).toContain("Local durable coding agent")
    expect(output.join("\n")).toContain("diagnostics")
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
            RIKA_DATABASE: path.join(dataRoot, "rika.db"),
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
          const dataRoot = path.join(root, "state")
          const diagnostics = path.join(dataRoot, "diagnostics")
          const destination = path.join(root, "export")
          yield* fileSystem.makeDirectory(diagnostics, { recursive: true, mode: 0o700 })
          yield* fileSystem.writeFileString(path.join(diagnostics, "server-crash.open.jsonl"), '{"partial":', {
            mode: 0o600,
          })
          const provider = ConfigProvider.fromEnv({
            env: {
              HOME: path.join(root, "home"),
              RIKA_DATABASE: path.join(dataRoot, "rika.db"),
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

it.effect("dispatches a parsed doctor operation", () =>
  Effect.gen(function* () {
    expect(yield* capture(["doctor"])).toEqual([{ _tag: "Doctor" }])
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

it.effect("normalizes optional thread-list values", () =>
  Effect.gen(function* () {
    expect(yield* capture(["thread", "list", "--limit", "5"])).toEqual([{ _tag: "Thread", action: "list", limit: 5 }])
  }),
)

it.effect("dispatches interactive and execute inputs", () =>
  Effect.gen(function* () {
    expect(yield* capture(["hello", "world", "--mode", "high", "--ephemeral"])).toEqual([
      { _tag: "Interactive", prompt: ["hello", "world"], mode: "high", ephemeral: true },
    ])
    expect(
      yield* capture([
        "-x",
        "hello",
        "--workspace",
        ".",
        "--thread",
        "thread-1",
        "--stream-json",
        "--stream-json-input",
        "--stream-json-thinking",
      ]),
    ).toEqual([
      {
        _tag: "Run",
        prompt: ["hello"],
        workspace,
        threadId: "thread-1",
        ephemeral: false,
        streamJson: true,
        streamJsonInput: true,
        streamJsonThinking: true,
      },
    ])
    expect(yield* capture(["run", "hello", "--mode", "low"])).toEqual([
      {
        _tag: "Run",
        prompt: ["hello"],
        mode: "low",
        ephemeral: false,
        streamJson: false,
        streamJsonInput: false,
        streamJsonThinking: false,
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

it.effect("dispatches every thread operation", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Input]> = [
      [["thread", "new"], { _tag: "Thread", action: "new" }],
      [["thread", "continue", "--last"], { _tag: "Interactive", prompt: [], last: true, ephemeral: false }],
      [["thread", "continue", "a"], { _tag: "Interactive", prompt: [], threadId: "a", ephemeral: false }],
      [["thread", "list", "--include-archived"], { _tag: "Thread", action: "list", includeArchived: true }],
      [["thread", "list"], { _tag: "Thread", action: "list" }],
      [["thread", "search", "hello"], { _tag: "Thread", action: "search", query: ["hello"] }],
      [
        ["thread", "search", "hello", "world", "--include-archived", "--limit", "2"],
        { _tag: "Thread", action: "search", query: ["hello", "world"], includeArchived: true, limit: 2 },
      ],
      [["thread", "rename", "a", "Title"], { _tag: "Thread", action: "rename", threadId: "a", title: "Title" }],
      [
        ["thread", "label", "a", "one", "two"],
        { _tag: "Thread", action: "label", threadId: "a", labels: ["one", "two"] },
      ],
      [["thread", "pin", "a"], { _tag: "Thread", action: "pin", threadId: "a" }],
      [["thread", "archive", "a"], { _tag: "Thread", action: "archive", threadId: "a" }],
      [["thread", "unarchive", "a"], { _tag: "Thread", action: "unarchive", threadId: "a" }],
      [["thread", "delete", "a"], { _tag: "Thread", action: "delete", threadId: "a" }],
      [["thread", "usage", "a"], { _tag: "Thread", action: "usage", threadId: "a" }],
      [["thread", "fork", "a"], { _tag: "Thread", action: "fork", threadId: "a" }],
      [["thread", "fork", "a", "--at-turn", "t"], { _tag: "Thread", action: "fork", threadId: "a", atTurn: "t" }],
      [["thread", "export", "a"], { _tag: "Thread", action: "export", threadId: "a", format: "json" }],
      [
        ["thread", "export", "a", "--format", "markdown"],
        { _tag: "Thread", action: "export", threadId: "a", format: "markdown" },
      ],
      [["last"], { _tag: "Thread", action: "last" }],
      [["top"], { _tag: "Thread", action: "top" }],
    ]
    for (const [argv, expected] of cases) expect(yield* capture(argv)).toEqual([expected])
  }),
)

it.effect("rejects invalid thread relationships", () =>
  Effect.gen(function* () {
    yield* failsWithoutDispatch(["thread", "continue"])
    yield* failsWithoutDispatch(["thread", "continue", "--last", "a"])
    yield* failsWithoutDispatch(["thread", "continue", "a", "b"])
    yield* failsWithoutDispatch(["thread", "search"])
    yield* failsWithoutDispatch(["thread", "label", "a"])
    yield* failsWithoutDispatch(["thread", "rename"])
    yield* failsWithoutDispatch(["thread", "pin"])
    yield* failsWithoutDispatch(["thread", "archive"])
    yield* failsWithoutDispatch(["thread", "unarchive"])
    yield* failsWithoutDispatch(["thread", "delete"])
    yield* failsWithoutDispatch(["thread", "usage"])
    yield* failsWithoutDispatch(["thread", "fork"])
    yield* failsWithoutDispatch(["thread", "export"])
    yield* failsWithoutDispatch(["thread", "export", "a", "--format", "xml"])
  }),
)

it.effect("dispatches catalog, extension, and maintenance operations", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Input]> = [
      [["config", "list"], { _tag: "Config", action: "list" }],
      [["config", "edit", "--workspace"], { _tag: "Config", action: "edit", workspace: true }],
      [["config", "keymap"], { _tag: "Config", action: "keymap" }],
      [["credential", "list", "openai"], { _tag: "Credential", action: "list", provider: "openai" }],
      [["credential", "revoke", "openai"], { _tag: "Credential", action: "revoke", provider: "openai" }],
      [["tools", "list"], { _tag: "ToolCatalog", action: "list" }],
      [["tools", "list", "--mode", "ultra"], { _tag: "ToolCatalog", action: "list", mode: "ultra" }],
      [["tools", "list", "--mode", "deep-review"], { _tag: "ToolCatalog", action: "list", mode: "deep-review" }],
      [["tools", "show", "read"], { _tag: "ToolCatalog", action: "show", name: "read" }],
      [["skills", "list"], { _tag: "Skill", action: "list" }],
      [["skills", "inspect", "x"], { _tag: "Skill", action: "inspect", name: "x" }],
      [["skills", "add", "source"], { _tag: "Skill", action: "add", source: "source" }],
      [["skills", "remove", "x"], { _tag: "Skill", action: "remove", name: "x" }],
      [["extensions", "create-skill", "x"], { _tag: "Extension", action: "create-skill", name: "x" }],
      [["extensions", "create-plugin", "x"], { _tag: "Extension", action: "create-plugin", name: "x" }],
      [["extensions", "list"], { _tag: "Extension", action: "list" }],
      [["extensions", "enable", "x"], { _tag: "Extension", action: "enable", name: "x" }],
      [["extensions", "disable", "x"], { _tag: "Extension", action: "disable", name: "x" }],
      [["extensions", "rollback", "x"], { _tag: "Extension", action: "rollback", name: "x" }],
    ]
    for (const [argv, expected] of cases) expect(yield* capture(argv)).toEqual([expected])
  }),
)

it.effect("dispatches every MCP operation and validates add transport", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Input]> = [
      [["mcp", "list"], { _tag: "Mcp", action: "list" }],
      [
        ["mcp", "add", "local", "bun", "server.ts"],
        { _tag: "Mcp", action: "add", name: "local", command: ["bun", "server.ts"] },
      ],
      [
        ["mcp", "add", "remote", "--url", "https://example.com"],
        { _tag: "Mcp", action: "add", name: "remote", url: "https://example.com" },
      ],
      [["mcp", "remove", "x"], { _tag: "Mcp", action: "remove", name: "x" }],
      [["mcp", "enable", "x"], { _tag: "Mcp", action: "enable", name: "x" }],
      [["mcp", "disable", "x"], { _tag: "Mcp", action: "disable", name: "x" }],
      [["mcp", "doctor"], { _tag: "Mcp", action: "doctor" }],
      [["mcp", "oauth", "login", "x"], { _tag: "Mcp", action: "oauth-login", name: "x" }],
      [["mcp", "oauth", "logout", "x"], { _tag: "Mcp", action: "oauth-logout", name: "x" }],
      [["mcp", "oauth", "status"], { _tag: "Mcp", action: "oauth-status" }],
      [["mcp", "oauth", "status", "x"], { _tag: "Mcp", action: "oauth-status", name: "x" }],
    ]
    for (const [argv, expected] of cases) expect(yield* capture(argv)).toEqual([expected])
    yield* failsWithoutDispatch(["mcp", "add", "x"])
    yield* failsWithoutDispatch(["mcp", "add", "x", "bun", "--url", "https://example.com"])
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
        yield* run(["config", "--help"])
        yield* run(["tools", "--help"])
        yield* run(["skills", "--help"])
        yield* run(["mcp", "--help"])
        yield* run(["extensions", "--help"])
        return yield* TestConsole.logLines
      }),
      layer,
    )
    expect(output.join("\n")).toContain("0.0.0")
    expect(output.join("\n")).toContain("Manage local and remote durable threads")
    expect(yield* Ref.get(calls)).toEqual([])
  }),
)
