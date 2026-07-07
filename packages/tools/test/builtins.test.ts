import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PermissionPolicy,
  SkillRegistry,
  SkillToolProvider,
  SubagentRuntime,
  ThreadMemory,
  ToolExecutor,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore, McpApprovalStore } from "@rika/persistence"
import { Common } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { BuiltInTools, McpClient, SpecialtyTools } from "../src/index"
import { PluginHost } from "@rika/plugin"

const configLayer = (workspaceRoot: string, subagentTools?: Config.SubagentTools) =>
  Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
    ...(subagentTools === undefined ? {} : { subagent_tools: subagentTools }),
  })

const diagnosticsLayer = () => {
  const redactorLayer = SecretRedactor.layer
  return Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
}

describe("BuiltInTools", () => {
  test("readonly subagent executor exposes only the read-only tool list", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-builtins-readonly-"))
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* ToolExecutor.SubagentService
        const descriptors = yield* executor.describe
        return descriptors.map((descriptor) => descriptor.name)
      }).pipe(Effect.provide(subagentToolLayer(root))),
    )

    expect(names).toEqual([...SubagentRuntime.readOnlyToolNames])
  })

  test("full subagent executor exposes workspace mutation tools without recursive task", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-builtins-"))
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* ToolExecutor.SubagentService
        const descriptors = yield* executor.describe
        return descriptors.map((descriptor) => descriptor.name)
      }).pipe(Effect.provide(subagentToolLayer(root, "full"))),
    )

    expect(names).toContain("shell_command")
    expect(names).toContain("edit")
    expect(names).not.toContain("task")
  })

  test("full-mode subagents can perform a real file edit in a temp workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-builtins-edit-"))
    await writeFile(join(root, "notes.txt"), "before\n")
    let requestCount = 0
    const routerLayer = fakeRouterLayer(() =>
      Effect.sync(() => {
        requestCount += 1
        if (requestCount === 1) {
          return response(
            JSON.stringify({
              tool_call: {
                name: "edit",
                input: {
                  path: "notes.txt",
                  edits: [
                    {
                      type: "replace_text",
                      old_text: "before",
                      new_text: "after",
                      exact: true,
                    },
                  ],
                },
              },
            }),
          )
        }
        return response("Edited notes.txt.\n- notes.txt")
      }),
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({ agents: [{ name: "editor", prompt: "replace before with after" }] }).pipe(
        Effect.provide(
          SubagentRuntime.layer.pipe(
            Layer.provideMerge(configLayer(root, "full")),
            Layer.provideMerge(IdGenerator.sequenceLayer(1)),
            Layer.provideMerge(Time.fixedLayer(Common.TimestampMillis.make(2_100_000_000_000))),
            Layer.provideMerge(routerLayer),
            Layer.provide(subagentToolLayer(root, "full")),
          ),
        ),
      ),
    )

    expect(result.runs[0]).toMatchObject({
      status: "completed",
      tool_access: "read-write",
      evidence: ["notes.txt"],
    })
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("after\n")
  })

  test("skill MCP tools are provided only for selected skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-builtins-skill-mcp-"))
    const calls: Array<string> = []
    const skill: SkillRegistry.Skill = {
      summary: {
        name: "deploy",
        description: "Deploy code",
        source: "project",
        directory: join(root, ".agents", "skills", "deploy"),
        skill_file: join(root, ".agents", "skills", "deploy", "SKILL.md"),
      },
      instructions: "Deploy instructions",
      resources: [],
      mcp_servers: { deployer: { url: "https://example.com/mcp" } },
    }
    const connector: McpClient.Connector = (server) =>
      Effect.succeed({
        listTools: Effect.sync(() => {
          calls.push(`list:${server.name}`)
          calls.push(`cwd:${server.default_cwd}`)
          return [{ name: "echo", inputSchema: { type: "object" } }]
        }),
        callTool: (name, input) => Effect.succeed({ name, input }),
        close: Effect.void,
      })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SkillToolProvider.Service
        const hidden = yield* provider.definitionsForSkills([])
        const selected = yield* provider.definitionsForSkills([skill])
        return { hidden, selected }
      }).pipe(
        Effect.provide(
          BuiltInTools.skillToolProviderLayerFromServices.pipe(
            Layer.provideMerge(
              McpClient.layerFromSources([], connector).pipe(
                Layer.provideMerge(configLayer(root)),
                Layer.provideMerge(McpApprovalStore.fakeLayer()),
              ),
            ),
          ),
        ),
      ),
    )

    expect(result.hidden).toEqual([])
    expect(result.selected.map((definition) => definition.tool.name)).toEqual(["mcp.deployer.echo"])
    expect(calls).toEqual(["list:deployer", `cwd:${skill.summary.directory}`])
  })
})

const subagentToolLayer = (workspaceRoot: string, subagentTools?: Config.SubagentTools) =>
  BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(PermissionPolicy.defaultConfig).pipe(
    Layer.provideMerge(configLayer(workspaceRoot, subagentTools)),
    Layer.provideMerge(PluginHost.emptyLayer),
    Layer.provideMerge(SpecialtyTools.fakeLayer()),
    Layer.provideMerge(ArtifactStore.fakeLayer()),
    Layer.provideMerge(ThreadMemory.fakeLayer()),
    Layer.provideMerge(McpApprovalStore.fakeLayer()),
    Layer.provideMerge(McpClient.emptyLayer),
    Layer.provideMerge(IdGenerator.sequenceLayer(10)),
    Layer.provideMerge(Time.fixedLayer(Common.TimestampMillis.make(2_100_000_000_000))),
    Layer.provideMerge(diagnosticsLayer()),
  )

const fakeRouterLayer = (complete: (request: Router.Request) => Effect.Effect<Provider.GenerateResponse>) =>
  Layer.succeed(
    Router.Service,
    Router.Service.of({
      route: Effect.fn("BuiltInTools.test.route")(function* (request: Router.Request) {
        return {
          mode: request.mode ?? "smart",
          provider: request.provider ?? "openai",
          model: request.model ?? "fake-model",
          messages: request.messages,
          reasoning_effort: request.reasoning_effort ?? "none",
        }
      }),
      complete: Effect.fn("BuiltInTools.test.complete")(complete),
      completeStructured: () => Effect.die(new Error("structured completion not configured")),
      stream: (request: Router.Request) =>
        Stream.fromIterable(
          Provider.streamEventsFromResponse(response(providerMessageText(request.messages.at(-1)?.content ?? ""))),
        ),
    }),
  )

const response = (content: string): Provider.GenerateResponse => ({ provider: "openai", model: "fake-model", content })

const providerMessageText = (content: Provider.MessageContent): string =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
