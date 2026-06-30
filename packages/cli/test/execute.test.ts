import { describe, expect, test } from "bun:test"
import { AgentLoop, ContextResolver, SkillRegistry, ToolExecutor } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Execute, Output } from "../src/index"

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-cli-test",
  data_dir: "/workspace/rika-cli-test/.rika",
  default_mode: "smart",
})

const makeLayer = (output: Output.MemoryOutput) => {
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
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(Common.TimestampMillis.make(1_950_000_000_000)),
    IdGenerator.sequenceLayer(1),
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
})
