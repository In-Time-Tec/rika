import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation } from "@rika/app"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import { parseJsonLines, readStreamInput, run } from "../src/command"

const workspace = process.cwd()

const execute = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>) => effect.pipe(Effect.provide(layer))

const capture = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, TestConsole.layer, Operation.testLayer(calls))
    yield* execute(run(argv), layer)
    return yield* Ref.get(calls)
  })

const failsWithoutDispatch = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, TestConsole.layer, Operation.testLayer(calls))
    const exit = yield* Effect.exit(run(argv).pipe(Effect.provide(layer)))
    expect(exit._tag).toBe("Failure")
    expect(yield* Ref.get(calls)).toEqual([])
  })

it("parses JSONL prompt input and identifies malformed lines", () => {
  expect(parseJsonLines('"one"\n{"prompt":"two"}\n')).toEqual(["one", "two"])
  expect(() => parseJsonLines('"one"\nnot-json\n')).toThrow("Invalid JSON on stdin line 2")
  expect(() => parseJsonLines("42")).toThrow("must be a string or prompt object")
})

const streamInput = (prompt: ReadonlyArray<string> = []) => ({
  _tag: "Run" as const,
  prompt,
  ephemeral: false,
  streamJson: true,
  streamJsonInput: true,
  streamJsonThinking: false,
})

const validChunks = async function* () {
  yield '"one"\n'
  yield '{"prompt":"two"}\n'
}

it.effect("reads valid, invalid, and empty JSONL stream input", () =>
  Effect.gen(function* () {
    expect((yield* readStreamInput(streamInput(), validChunks())).prompt).toEqual(["one", "two"])
    expect((yield* readStreamInput(streamInput(), (async function* () {})())).prompt).toEqual([])
    expect(
      (yield* Effect.result(
        readStreamInput(
          streamInput(),
          (async function* () {
            yield "bad"
          })(),
        ),
      ))._tag,
    ).toBe("Failure")
    expect((yield* readStreamInput(streamInput(["existing"]), validChunks())).prompt).toEqual(["existing"])
  }),
)

it.effect("maps stdin failures and dispatch failures", () =>
  Effect.gen(function* () {
    const broken = {
      [Symbol.asyncIterator]() {
        throw new Error("stdin unavailable")
      },
    }
    const read = yield* Effect.result(readStreamInput(streamInput(), broken))
    expect(read._tag === "Failure" && read.failure.message).toContain("Unable to read JSON input")
    const layer = Layer.mergeAll(
      BunServices.layer,
      TestConsole.layer,
      Layer.succeed(
        Operation.Service,
        Operation.Service.of({
          run: () =>
            Effect.fail(new Operation.OperationUnavailable({ operation: "Doctor", message: "dispatch failed" })),
        }),
      ),
    )
    expect((yield* Effect.exit(run(["doctor"]).pipe(Effect.provide(layer))))._tag).toBe("Failure")
  }),
)

it.effect("renders help without dispatching an operation", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, TestConsole.layer, Operation.testLayer(calls))
    const output = yield* execute(
      Effect.gen(function* () {
        yield* run(["--help"])
        return yield* TestConsole.logLines
      }),
      layer,
    )
    expect(output.join("\n")).toContain("Local durable coding agent")
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

it.effect("normalizes optional thread-list values", () =>
  Effect.gen(function* () {
    expect(yield* capture(["threads", "list", "--limit", "5"])).toEqual([{ _tag: "Thread", action: "list", limit: 5 }])
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

it.effect("dispatches every thread operation", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Operation.Input]> = [
      [["threads", "new"], { _tag: "Thread", action: "new" }],
      [["threads", "continue", "--last"], { _tag: "Interactive", prompt: [], last: true, ephemeral: false }],
      [["threads", "continue", "a"], { _tag: "Interactive", prompt: [], threadId: "a", ephemeral: false }],
      [["threads", "list", "--include-archived"], { _tag: "Thread", action: "list", includeArchived: true }],
      [["threads", "list"], { _tag: "Thread", action: "list" }],
      [["threads", "search", "hello"], { _tag: "Thread", action: "search", query: ["hello"] }],
      [
        ["threads", "search", "hello", "world", "--include-archived", "--limit", "2"],
        { _tag: "Thread", action: "search", query: ["hello", "world"], includeArchived: true, limit: 2 },
      ],
      [["threads", "rename", "a", "Title"], { _tag: "Thread", action: "rename", threadId: "a", title: "Title" }],
      [
        ["threads", "label", "a", "one", "two"],
        { _tag: "Thread", action: "label", threadId: "a", labels: ["one", "two"] },
      ],
      [["threads", "pin", "a"], { _tag: "Thread", action: "pin", threadId: "a" }],
      [["threads", "archive", "a"], { _tag: "Thread", action: "archive", threadId: "a" }],
      [["threads", "unarchive", "a"], { _tag: "Thread", action: "unarchive", threadId: "a" }],
      [["threads", "delete", "a"], { _tag: "Thread", action: "delete", threadId: "a" }],
      [["threads", "usage", "a"], { _tag: "Thread", action: "usage", threadId: "a" }],
      [["threads", "fork", "a"], { _tag: "Thread", action: "fork", threadId: "a" }],
      [["threads", "fork", "a", "--at-turn", "t"], { _tag: "Thread", action: "fork", threadId: "a", atTurn: "t" }],
      [["threads", "export", "a"], { _tag: "Thread", action: "export", threadId: "a", format: "json" }],
      [
        ["threads", "export", "a", "--format", "markdown"],
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
    yield* failsWithoutDispatch(["threads", "continue"])
    yield* failsWithoutDispatch(["threads", "continue", "--last", "a"])
    yield* failsWithoutDispatch(["threads", "search"])
    yield* failsWithoutDispatch(["threads", "label", "a"])
  }),
)

it.effect("dispatches catalog, extension, review, and maintenance operations", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Operation.Input]> = [
      [["config", "list"], { _tag: "Config", action: "list" }],
      [["config", "edit", "--workspace"], { _tag: "Config", action: "edit", workspace: true }],
      [["config", "keymap"], { _tag: "Config", action: "keymap" }],
      [["tools", "list"], { _tag: "ToolCatalog", action: "list" }],
      [["tools", "list", "--mode", "ultra"], { _tag: "ToolCatalog", action: "list", mode: "ultra" }],
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
      [
        ["review", "--staged", "--base", "main", "--workspace", ".", "--ephemeral", "--json", "a", "b"],
        { _tag: "Review", staged: true, base: "main", workspace, ephemeral: true, json: true, paths: ["a", "b"] },
      ],
      [["review"], { _tag: "Review", staged: false, ephemeral: false, json: false, paths: [] }],
      [["update"], { _tag: "Update" }],
      [
        ["workflows", "start", "delivery", "delivery-1"],
        { _tag: "Workflow", action: "start", name: "delivery", runId: "delivery-1" },
      ],
      [
        ["workflows", "start", "research-synthesis", "research-1", "--revision", "2"],
        { _tag: "Workflow", action: "start", name: "research-synthesis", runId: "research-1", revision: 2 },
      ],
      [["workflows", "inspect", "delivery-1"], { _tag: "Workflow", action: "inspect", runId: "delivery-1" }],
    ]
    for (const [argv, expected] of cases) expect(yield* capture(argv)).toEqual([expected])
  }),
)

it.effect("dispatches every MCP operation and validates add transport", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Operation.Input]> = [
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
      [["mcp", "approve", "x"], { _tag: "Mcp", action: "approve", name: "x" }],
      [["mcp", "approve", "x", "--workspace", "."], { _tag: "Mcp", action: "approve", name: "x", workspace }],
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
    const calls = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
    const layer = Layer.mergeAll(BunServices.layer, TestConsole.layer, Operation.testLayer(calls))
    const output = yield* execute(
      Effect.gen(function* () {
        yield* run(["version"])
        yield* run(["threads", "--help"])
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
    expect(output.join("\n")).toContain("Manage local durable threads")
    expect(yield* Ref.get(calls)).toEqual([])
  }),
)
