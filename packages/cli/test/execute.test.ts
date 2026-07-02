import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentLoop, ContextResolver, SkillRegistry, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ProjectStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Execute, Output } from "../src/index"

const defaultWorkspaceRoot = "/workspace/rika-cli-test"
const defaultDataDir = "/workspace/rika-cli-test/.rika"

const makeLayer = (output: Output.MemoryOutput, workspaceRoot = defaultWorkspaceRoot, dataDir = defaultDataDir) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(Common.TimestampMillis.make(1_950_000_000_000))
  const idLayer = IdGenerator.sequenceLayer(1)
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(
      Provider.fakeRegistryLayer([
        { name: "anthropic", responses: ["cli response"] },
        { name: "openai", responses: ["cli response"] },
      ]),
    ),
  )
  const baseLayer = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(output),
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    idLayer,
    projectStoreLayer,
    Diagnostics.memoryLayer([]),
    ContextResolver.emptyLayer,
    SkillRegistry.emptyLayer,
    ToolExecutor.emptyLayer,
    llmLayer,
  )

  return Execute.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))))
}

describe("CLI execute", () => {
  test("runs one prompt and streams schema-parseable JSON events", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["run", "ship", "it", "--mode", "rush"])
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))
    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" })
  })

  test("prints actionable diagnostics and exits non-zero for invalid args", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Execute.execute(["run", "--bogus"]).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(2)
    expect(output.stdout).toEqual([])
    expect(output.stderr.join("\n")).toContain("Unrecognized flag: --bogus")
    expect(output.stderr.join("\n")).toContain("USAGE")
  })

  test("accepts explicit workspace and thread ids", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const threadId = Ids.ThreadId.make("thread_cli_explicit")

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Execute.execute(["--execute", "--workspace", "/workspace/custom", "--thread", threadId, "hello"])
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const first = Schema.decodeUnknownSync(Event.Event)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(first.thread_id).toBe(threadId)
    expect(first).toMatchObject({ type: "thread.created", data: { workspace_id: "/workspace/custom" } })
  })

  test("uses project workspace identity when the git remote matches a stored project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-cli-execute-data-"))
    const workspaceRoot = await mkdtemp(join(tmpdir(), "rika-cli-execute-workspace-"))
    await runGit(workspaceRoot, ["init"])
    await runGit(workspaceRoot, ["remote", "add", "origin", "https://github.com/x/y"])
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({ name: "demo", repo_origin: "https://github.com/x/y" })
        return yield* Execute.execute(["run", "--workspace", workspaceRoot, "hello"])
      }).pipe(Effect.provide(makeLayer(output, workspaceRoot, dataDir))),
    )

    const first = Schema.decodeUnknownSync(Event.Event)(JSON.parse(output.stdout[0] ?? "{}"))

    expect(exitCode).toBe(0)
    expect(first).toMatchObject({
      type: "thread.created",
      data: { workspace_id: Ids.WorkspaceId.make("project:project_1") },
    })
    expect(output.stderr).toEqual([])
    await rm(dataDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  })
})

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr)
}
