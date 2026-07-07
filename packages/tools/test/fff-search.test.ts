import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionPolicy, SubagentRuntime, ThreadMemory, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { ArtifactStore } from "@rika/persistence"
import { PluginHost } from "@rika/plugin"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer } from "effect"
import {
  AstGrepOutline,
  BuiltInTools,
  FffSearch,
  HashlineFile,
  McpClient,
  SemanticSearch,
  SpecialtyTools,
} from "../src/index"

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-fff-"))

const configLayer = (workspaceRoot: string) =>
  Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
  })

const diagnosticsLayer = () => {
  const redactorLayer = SecretRedactor.layer
  return Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
}

const fakeFiles = [
  { path: "packages/core/src/config.ts", content: "export const Config = 1\nconst target = 'alpha'\n" },
  { path: "packages/core/test/config.test.ts", content: "test('target alpha', () => {})\n" },
  { path: "packages/tools/src/search.ts", content: "export function searchTool() { return 'target beta' }\n" },
  { path: "README.md", content: "target docs\n" },
]

const outlineRunner: AstGrepOutline.CommandRunner = {
  run: (command, args) =>
    args.length === 1 && args[0] === "--version"
      ? Effect.succeed({ stdout: `${command} 0.44.0\n`, stderr: "" })
      : Effect.succeed({ stdout: "outline\n", stderr: "" }),
}

const run = <A, E>(workspaceRoot: string, effect: Effect.Effect<A, E, FffSearch.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(FffSearch.fakeLayer(fakeFiles)), Effect.provide(configLayer(workspaceRoot))),
  )

const runTool = <A, E>(workspaceRoot: string, effect: Effect.Effect<A, E, ToolExecutor.Service>) => {
  const registryLayer = BuiltInTools.registryLayerFromServices.pipe(
    Layer.provideMerge(SemanticSearch.fakeLayer()),
    Layer.provideMerge(FffSearch.fakeLayer(fakeFiles)),
    Layer.provideMerge(AstGrepOutline.fakeLayer(outlineRunner)),
    Layer.provideMerge(HashlineFile.layer),
    Layer.provideMerge(SpecialtyTools.fakeLayer()),
    Layer.provideMerge(ThreadMemory.fakeLayer()),
    Layer.provideMerge(ArtifactStore.fakeLayer()),
    Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    Layer.provideMerge(Time.layer),
    Layer.provideMerge(McpClient.emptyLayer),
    Layer.provideMerge(PluginHost.emptyLayer),
    Layer.provideMerge(SubagentRuntime.fakeLayer(() => Effect.succeed({ type: "subagent.batch", runs: [] }))),
    Layer.provideMerge(configLayer(workspaceRoot)),
  )
  const executorLayer = ToolExecutor.layer.pipe(
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(PermissionPolicy.allowLayer),
    Layer.provideMerge(diagnosticsLayer()),
  )
  return Effect.runPromise(effect.pipe(Effect.provide(executorLayer)))
}

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name}`),
  name,
  input,
})

describe("FffSearch", () => {
  test("file search returns compact repo-relative paths with pagination metadata", async () => {
    const root = await tempWorkspace()
    const output = object(await run(root, FffSearch.fileSearch({ query: "config", page_size: 1 })))

    expect(output).toMatchObject({ type: "fff.file_search", backend: "fake", total_matched: 2 })
    expect(object(output.page)).toMatchObject({ index: 0, size: 1, has_more: true })
    expect(output.content).toBe("packages/core/src/config.ts")
    expect(object(array(output.items)[0]).path).toBe("packages/core/src/config.ts")
  })

  test("glob and directory search narrow indexed paths", async () => {
    const root = await tempWorkspace()
    const glob = object(await run(root, FffSearch.glob({ pattern: "packages/**/*.ts" })))
    const directories = object(await run(root, FffSearch.directorySearch({ query: "tools" })))

    expect(array(glob.items).map((item) => object(item).path)).toEqual([
      "packages/core/src/config.ts",
      "packages/core/test/config.test.ts",
      "packages/tools/src/search.ts",
    ])
    expect(String(directories.content)).toContain("packages/tools/src/")
  })

  test("grep returns cursor pagination and hashline anchors when files exist in the workspace", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "README.md"), "target docs\n")

    const output = object(await run(root, FffSearch.grep({ query: "target", page_size: 1, context: 1 })))
    const firstMatch = object(array(output.matches)[0])

    expect(output).toMatchObject({ type: "fff.grep", backend: "fake", next_cursor: 1 })
    expect(firstMatch).toMatchObject({ path: "packages/core/src/config.ts", line_number: 2 })

    const readmePage = object(await run(root, FffSearch.grep({ query: "target", path: "README.md", page_size: 10 })))
    const readmeMatch = object(array(readmePage.matches)[0])
    expect(readmeMatch).toMatchObject({ path: "README.md", anchor: expect.stringMatching(/^1:[A-Za-z0-9_-]{4}$/) })
  })

  test("multi grep searches several patterns in one pass", async () => {
    const root = await tempWorkspace()
    const output = object(
      await run(root, FffSearch.multiGrep({ patterns: ["alpha", "beta"], constraints: "packages/" })),
    )

    expect(array(output.matches).map((match) => object(match).path)).toEqual([
      "packages/core/src/config.ts",
      "packages/core/test/config.test.ts",
      "packages/tools/src/search.ts",
    ])
  })

  test("factory failures fall back to a workspace scanner instead of dropping search tools", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "local.ts"), "const target = true\n")
    const layer = FffSearch.layerFromFactory(
      () => new FffSearch.FffSearchError({ message: "native library missing", code: "E_NATIVE_UNAVAILABLE" }),
      { fallbackOnNativeError: true },
    )

    const output = object(
      await Effect.runPromise(
        FffSearch.grep({ query: "target" }).pipe(Effect.provide(layer), Effect.provide(configLayer(root))),
      ),
    )

    expect(output).toMatchObject({ backend: "fallback", degraded_reason: "native library missing" })
    expect(object(array(output.matches)[0]).path).toBe("local.ts")
  })

  test("built-in tool layer exposes fff search plus hashline editing", async () => {
    const root = await tempWorkspace()
    const descriptors = await runTool(root, ToolExecutor.describe())
    const names = descriptors.map((descriptor) => descriptor.name)

    expect(names).toEqual([
      "shell_command",
      "task",
      "oracle",
      "librarian",
      "painter",
      "thread_memory",
      "semantic_search",
      "semantic_search_status",
      "fffind",
      "fff_glob",
      "fff_directory_search",
      "ffgrep",
      "fff_multi_grep",
      "fff_health",
      "fff_rescan",
      "ast_grep_outline",
      "read",
      "write",
      "edit",
    ])

    const searchResult = await runTool(root, ToolExecutor.execute(call("fffind", { query: "search" })))
    const writeResult = await runTool(
      root,
      ToolExecutor.execute(call("write", { path: "tool.txt", content: "hello\n" })),
    )
    expect(searchResult).toMatchObject({ status: "success", name: "fffind" })
    expect(writeResult).toMatchObject({ status: "success", name: "write" })
  })
})

const object = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) return value
  throw new Error(`Expected object, got ${typeof value}`)
}

const array = (value: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value
  throw new Error(`Expected array, got ${typeof value}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
