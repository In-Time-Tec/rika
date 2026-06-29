import { describe, expect, test } from "bun:test"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { Database, McpApprovalStore } from "@rika/persistence"
import { Common, Ids, Tool } from "@rika/schema"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { McpClient } from "../src/index"

const configLayer = Config.layerFromValues({
  workspace_root: "/repo",
  data_dir: "/repo/.rika",
  default_mode: "smart",
})

const workspaceSource = (servers: Readonly<Record<string, McpClient.ServerConfig>>): McpClient.SettingsSource => ({
  source: "workspace",
  path: "/repo/.rika/settings.json",
  servers,
})

const userSource = (servers: Readonly<Record<string, McpClient.ServerConfig>>): McpClient.SettingsSource => ({
  source: "user",
  path: "/home/user/.config/rika/settings.json",
  servers,
})

const toolCall = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name.replaceAll(".", "_")}`),
  name,
  input,
})

interface FakeServer {
  readonly tools: ReadonlyArray<McpClient.RemoteTool>
  readonly call?: (name: string, input: Common.JsonValue) => Effect.Effect<Common.JsonValue, McpClient.McpClientError>
}

const fakeConnector =
  (servers: Readonly<Record<string, FakeServer>>, calls: Array<string> = []): McpClient.Connector =>
  (server) =>
    Effect.gen(function* () {
      calls.push(`connect:${server.name}`)
      const fake = servers[server.name]
      if (fake === undefined) {
        return yield* new McpClient.McpClientError({
          message: `No fake MCP server ${server.name}`,
          operation: "connect",
          server_name: server.name,
        })
      }
      return {
        listTools: Effect.sync(() => {
          calls.push(`list:${server.name}`)
          return fake.tools
        }),
        callTool: (name: string, input: Common.JsonValue) => {
          calls.push(`call:${server.name}:${name}`)
          return fake.call?.(name, input) ?? Effect.succeed({ server: server.name, tool: name, input })
        },
        close: Effect.sync(() => calls.push(`close:${server.name}`)),
      }
    })

const layer = (
  sources: ReadonlyArray<McpClient.SettingsSource>,
  connector: McpClient.Connector,
  approvals = McpApprovalStore.fakeLayer(),
) => McpClient.layerFromSources(sources, connector).pipe(Layer.provideMerge(configLayer), Layer.provideMerge(approvals))

describe("McpClient", () => {
  test("requires approval before workspace command servers execute", async () => {
    const calls: Array<string> = []
    const runtime = layer(
      [workspaceSource({ local: { command: "node", args: ["server.js"] } })],
      fakeConnector({ local: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }, calls),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* McpClient.servers()
        const blockedDefinitions = yield* McpClient.toolDefinitions()
        const approval = yield* McpClient.approve("local")
        const after = yield* McpClient.servers()
        const definitions = yield* McpClient.toolDefinitions()
        return { before, blockedDefinitions, approval, after, definitions }
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.before).toMatchObject([
      { name: "local", source: "workspace", kind: "command", status: "approval_required" },
    ])
    expect(result.blockedDefinitions).toEqual([])
    expect(calls).toEqual(["connect:local", "list:local", "close:local"])
    expect(result.approval.server_name).toBe("local")
    expect(result.after).toMatchObject([{ name: "local", status: "ready" }])
    expect(result.definitions.map((definition) => definition.tool.name)).toEqual(["mcp.local.echo"])
  })

  test("filters tools before they reach the model context", async () => {
    const runtime = layer(
      [
        userSource({
          remote: { url: "https://example.com/mcp", includeTools: ["read*", "write"], excludeTools: ["write"] },
        }),
      ],
      fakeConnector({
        remote: {
          tools: [
            { name: "read_file", inputSchema: { type: "object" } },
            { name: "write", inputSchema: { type: "object" } },
            { name: "debug", inputSchema: { type: "object" } },
          ],
        },
      }),
    )

    const definitions = await Effect.runPromise(McpClient.toolDefinitions().pipe(Effect.provide(runtime)))

    expect(definitions.map((definition) => definition.tool.name)).toEqual(["mcp.remote.read_file"])
  })

  test("does not hide approval store failures when building MCP tool definitions", async () => {
    const approvals = Layer.succeed(
      McpApprovalStore.Service,
      McpApprovalStore.Service.of({
        approve: () =>
          Effect.fail(new Database.DatabaseError({ message: "approval database unavailable", operation: "approve" })),
        isApproved: () =>
          Effect.fail(
            new Database.DatabaseError({ message: "approval database unavailable", operation: "isApproved" }),
          ),
        list: () => Effect.succeed([]),
      }),
    )
    const runtime = layer(
      [workspaceSource({ local: { command: "node", args: ["server.js"] } })],
      fakeConnector({ local: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }),
      approvals,
    )

    const result = await Effect.runPromise(
      McpClient.toolDefinitions().pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
        Effect.provide(runtime),
      ),
    )

    expect(result).toBeInstanceOf(Database.DatabaseError)
  })

  test("registered MCP tools still pass through PermissionPolicy", async () => {
    const calls: Array<string> = []
    const runtime = layer(
      [userSource({ remote: { url: "https://example.com/mcp" } })],
      fakeConnector({ remote: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }, calls),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const definitions = yield* McpClient.toolDefinitions()
        return yield* ToolExecutor.execute(toolCall("mcp.remote.echo", { text: "hello" })).pipe(
          Effect.provide(ToolExecutor.layer),
          Effect.provide(ToolRegistry.layerFromDefinitions(definitions)),
          Effect.provide(PermissionPolicy.rejectLayer("blocked by policy")),
        )
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.status).toBe("error")
    expect(result.error?.kind).toBe("permission")
    expect(calls).toEqual(["connect:remote", "list:remote", "close:remote"])
  })

  test("maps MCP tool success and errors through normal ToolExecutor results", async () => {
    const runtime = layer(
      [userSource({ remote: { url: "https://example.com/mcp" } })],
      fakeConnector({
        remote: {
          tools: [
            { name: "ok", inputSchema: { type: "object" } },
            { name: "fail", inputSchema: { type: "object" } },
          ],
          call: (name, input) =>
            name === "fail"
              ? Effect.fail(
                  new McpClient.McpClientError({
                    message: "remote failed",
                    operation: "callTool",
                    server_name: "remote",
                    tool_name: name,
                    details: { input },
                  }),
                )
              : Effect.succeed({ ok: true, input }),
        },
      }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const definitions = yield* McpClient.toolDefinitions()
        const executorLayer = ToolExecutor.layer.pipe(
          Layer.provideMerge(ToolRegistry.layerFromDefinitions(definitions)),
          Layer.provideMerge(PermissionPolicy.allowLayer),
        )
        const success = yield* ToolExecutor.execute(toolCall("mcp.remote.ok", { text: "hello" })).pipe(
          Effect.provide(executorLayer),
        )
        const failure = yield* ToolExecutor.execute(toolCall("mcp.remote.fail", { text: "hello" })).pipe(
          Effect.provide(executorLayer),
        )
        return { success, failure }
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.success).toMatchObject({ status: "success", output: { ok: true, input: { text: "hello" } } })
    expect(result.failure).toMatchObject({ status: "error", error: { kind: "tool", message: "remote failed" } })
  })

  test("closes MCP connections when a tool call is interrupted", async () => {
    const calls: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const runtime = layer(
          [userSource({ remote: { url: "https://example.com/mcp" } })],
          fakeConnector(
            {
              remote: {
                tools: [{ name: "hang", inputSchema: { type: "object" } }],
                call: () => Deferred.succeed(started, undefined).pipe(Effect.flatMap(() => Effect.never)),
              },
            },
            calls,
          ),
        )
        const fiber = yield* McpClient.callTool("remote", "hang", {}).pipe(Effect.provide(runtime), Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return calls
      }),
    )

    expect(result).toEqual(["connect:remote", "call:remote:hang", "close:remote"])
  })
})
