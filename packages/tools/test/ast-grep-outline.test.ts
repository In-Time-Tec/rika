import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionPolicy, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer } from "effect"
import { AstGrepOutline } from "../src/index"

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-outline-"))

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

interface RecordedCall {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
}

const runner = (options: { readonly output?: string; readonly failVersion?: boolean } = {}) => {
  const calls: Array<RecordedCall> = []
  const commandRunner: AstGrepOutline.CommandRunner = {
    run: (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd })
      if (args.length === 1 && args[0] === "--version") {
        return options.failVersion === true
          ? new AstGrepOutline.AstGrepOutlineError({ message: "missing", code: "E_COMMAND_FAILED" })
          : Effect.succeed({ stdout: "ast-grep 0.44.0\n", stderr: "" })
      }
      return Effect.succeed({ stdout: options.output ?? "src/example.ts\n  function main() [1,1]", stderr: "" })
    },
  }
  return { calls, commandRunner }
}

const run = <A, E>(
  workspaceRoot: string,
  commandRunner: AstGrepOutline.CommandRunner,
  effect: Effect.Effect<A, E, AstGrepOutline.Service>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(AstGrepOutline.fakeLayer(commandRunner)), Effect.provide(configLayer(workspaceRoot))),
  )

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name}`),
  name,
  input,
})

describe("AstGrepOutline", () => {
  test("builds ast-grep outline arguments for files, directories, filters, and JSON output", async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "sgconfig.yml"), "ruleDirs: []\n")
    await writeFile(join(root, "outline.yml"), "rules: []\n")
    const fake = runner()

    const output = object(
      await run(
        root,
        fake.commandRunner,
        AstGrepOutline.outline({
          paths: ["src/example.ts", "src/example.py"],
          items: "all",
          view: "expanded",
          match: "Example",
          types: ["class", "function"],
          lang: "typescript",
          pubMembers: true,
          json: "compact",
          globs: ["**/*.ts", "!**/*.test.ts"],
          config: "sgconfig.yml",
          outlineRules: "outline.yml",
          noDefaultOutlineRules: true,
          noIgnore: ["hidden", "vcs"],
          follow: true,
        }),
      ),
    )

    expect(output).toMatchObject({ type: "ast_grep_outline", binary: "ast-grep", truncated: false })
    expect(fake.calls[1]?.args).toEqual([
      "outline",
      "--color",
      "never",
      "--items",
      "all",
      "--view",
      "expanded",
      "--lang",
      "typescript",
      "--match",
      "Example",
      "--type",
      "class,function",
      "--pub-members",
      "--json=compact",
      "--config",
      "sgconfig.yml",
      "--outline-rules",
      "outline.yml",
      "--no-default-outline-rules",
      "--follow",
      "--no-ignore",
      "hidden",
      "--no-ignore",
      "vcs",
      "--globs",
      "**/*.ts",
      "--globs",
      "!**/*.test.ts",
      "src/example.ts",
      "src/example.py",
    ])
  })

  test("caps output with an actionable truncation hint", async () => {
    const root = await tempWorkspace()
    const fake = runner({ output: "x".repeat(2_100) })
    const output = object(await run(root, fake.commandRunner, AstGrepOutline.outline({ maxOutputChars: 2_000 })))

    expect(output.truncated).toBe(true)
    expect(String(output.content)).toContain("output truncated at 2000 characters")
  })

  test("rejects paths and config files outside the workspace before running outline", async () => {
    const root = await tempWorkspace()
    const fake = runner()
    const error = await Effect.runPromise(
      AstGrepOutline.outline({ paths: "../outside.ts" }).pipe(
        Effect.flip,
        Effect.provide(AstGrepOutline.fakeLayer(fake.commandRunner)),
        Effect.provide(configLayer(root)),
      ),
    )

    expect(error).toMatchObject({ code: "E_PATH_OUTSIDE_WORKSPACE" })
    expect(fake.calls.map((record) => record.args[0])).toEqual(["--version"])
  })

  test("tool execution reports an explicit unavailable-binary error", async () => {
    const root = await tempWorkspace()
    const fake = runner({ failVersion: true })
    const registryLayer = AstGrepOutline.registryLayerFromService.pipe(
      Layer.provideMerge(AstGrepOutline.fakeLayer(fake.commandRunner)),
      Layer.provideMerge(configLayer(root)),
    )
    const executorLayer = ToolExecutor.layer.pipe(
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(PermissionPolicy.allowLayer),
      Layer.provideMerge(diagnosticsLayer()),
    )
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("ast_grep_outline", { paths: "src" })).pipe(Effect.provide(executorLayer)),
    )

    expect(result).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("ast-grep is not installed") },
    })
  })
})

const object = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) return value
  throw new Error(`Expected object, got ${typeof value}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
