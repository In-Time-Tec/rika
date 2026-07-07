import { describe, expect, test } from "bun:test"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { Database, McpApprovalStore } from "@rika/persistence"
import { Common, Ids, Tool } from "@rika/schema"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { McpClient } from "../src/index"

const configLayer = Config.layerFromValues({
  workspace_root: "/repo",
  data_dir: "/repo/.rika",
  default_mode: "smart",
})

const diagnosticsLayer = () => {
  const redactorLayer = SecretRedactor.layer
  return Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
}

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

const expectLaunchIdentityFailure = (result: { readonly _tag: string }) => {
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("expected launch identity failure")
  const failure = "failure" in result ? result.failure : undefined
  expect(failure).toBeInstanceOf(McpClient.McpClientError)
  if (!(failure instanceof McpClient.McpClientError)) throw new Error("expected McpClientError")
  expect(failure.operation).toBe("validateLaunchIdentity")
  expect(failure.details).toEqual({ fields: ["command", "args.0", "cwd"] })
}

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

  test("doctor reports unapproved workspace commands without connecting", async () => {
    const calls: Array<string> = []
    const runtime = layer(
      [workspaceSource({ local: { command: "node", args: ["server.js"] } })],
      fakeConnector({ local: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }, calls),
    )

    const health = await Effect.runPromise(McpClient.doctor().pipe(Effect.provide(runtime)))

    expect(health).toMatchObject([{ name: "local", status: "awaiting_approval" }])
    expect(calls).toEqual([])
  })

  test("skill-provided command definitions can be approved through source-aware approval", async () => {
    const calls: Array<string> = []
    const source: McpClient.SettingsSource = {
      ...workspaceSource({ skill: { command: "node", args: ["skill-server.js"] } }),
      default_cwd: "/repo/.agents/skills/deploy",
    }
    const runtime = layer([], (server) =>
      fakeConnector(
        { skill: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
        calls,
      )(server).pipe(Effect.tap(() => Effect.sync(() => calls.push(`cwd:${server.default_cwd}`)))),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const serversBefore = yield* McpClient.serversForSources([source])
        const before = yield* McpClient.toolDefinitionsForSources([source])
        const approval = yield* McpClient.approveForSources("skill", [source])
        const serversAfter = yield* McpClient.serversForSources([source])
        const after = yield* McpClient.toolDefinitionsForSources([source])
        return { serversBefore, before, approval, serversAfter, after }
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.serversBefore).toMatchObject([{ name: "skill", status: "approval_required" }])
    expect(result.before).toEqual([])
    expect(result.approval.server_name).toBe("skill")
    expect(result.serversAfter).toMatchObject([{ name: "skill", status: "ready" }])
    expect(result.after.map((definition) => definition.tool.name)).toEqual(["mcp.skill.echo"])
    expect(calls).toEqual(["connect:skill", "cwd:/repo/.agents/skills/deploy", "list:skill", "close:skill"])
  })

  test("skill command approval is scoped by effective launch cwd", async () => {
    const sourceA: McpClient.SettingsSource = {
      ...workspaceSource({ deployer: { command: "node", args: ["server.js"] } }),
      path: "/repo/.agents/skills/a/mcp.json",
      default_cwd: "/repo/.agents/skills/a",
    }
    const sourceB: McpClient.SettingsSource = {
      ...workspaceSource({ deployer: { command: "node", args: ["server.js"] } }),
      path: "/repo/.agents/skills/b/mcp.json",
      default_cwd: "/repo/.agents/skills/b",
    }
    const runtime = layer(
      [],
      fakeConnector({ deployer: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* McpClient.approveForSources("deployer", [sourceA])
        const a = yield* McpClient.serversForSources([sourceA])
        const b = yield* McpClient.serversForSources([sourceB])
        const bDefinitions = yield* McpClient.toolDefinitionsForSources([sourceB])
        return { a, b, bDefinitions }
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.a).toMatchObject([{ name: "deployer", status: "ready" }])
    expect(result.b).toMatchObject([{ name: "deployer", status: "approval_required" }])
    expect(result.bDefinitions).toEqual([])
  })

  test("skill command approval normalizes relative cwd before fingerprinting", async () => {
    const sourceA: McpClient.SettingsSource = {
      ...workspaceSource({ deployer: { command: "node", args: ["server.js"], cwd: "." } }),
      path: "/repo/.agents/skills/a/mcp.json",
      default_cwd: "/repo/.agents/skills/a",
    }
    const sourceB: McpClient.SettingsSource = {
      ...workspaceSource({ deployer: { command: "node", args: ["server.js"], cwd: "." } }),
      path: "/repo/.agents/skills/b/mcp.json",
      default_cwd: "/repo/.agents/skills/b",
    }
    const calls: Array<string> = []
    const runtime = layer([], (server) =>
      fakeConnector(
        { deployer: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
        calls,
      )(server).pipe(Effect.tap(() => Effect.sync(() => calls.push(`cwd:${server.default_cwd}`)))),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* McpClient.approveForSources("deployer", [sourceA])
        const a = yield* McpClient.serversForSources([sourceA])
        const b = yield* McpClient.serversForSources([sourceB])
        const aDefinitions = yield* McpClient.toolDefinitionsForSources([sourceA])
        const bDefinitions = yield* McpClient.toolDefinitionsForSources([sourceB])
        return { a, b, aDefinitions, bDefinitions }
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.a).toMatchObject([{ name: "deployer", status: "ready" }])
    expect(result.b).toMatchObject([{ name: "deployer", status: "approval_required" }])
    expect(result.aDefinitions.map((definition) => definition.tool.name)).toEqual(["mcp.deployer.echo"])
    expect(result.bDefinitions).toEqual([])
    expect(calls).toEqual(["connect:deployer", "cwd:/repo/.agents/skills/a", "list:deployer", "close:deployer"])
  })

  test("workspace command launch identity placeholders fail closed even with an existing approval", async () => {
    const config = {
      command: "${MCP_CMD}",
      args: ["${MCP_ARG}"],
      cwd: "${MCP_CWD}",
      env: { API_TOKEN: "${MCP_VALUE}" },
    }
    const source = workspaceSource({ local: config })
    const calls: Array<string> = []
    const runtime = layer(
      [],
      fakeConnector({ local: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }, calls),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* McpApprovalStore.approve({
          workspace_root: "/repo",
          server_name: "local",
          fingerprint: McpClient.fingerprintServerConfig(config, "/repo"),
        })
        const approve = yield* Effect.result(McpClient.approveForSources("local", [source]))
        const servers = yield* Effect.result(McpClient.serversForSources([source]))
        const definitions = yield* Effect.result(McpClient.toolDefinitionsForSources([source]))
        return { approve, servers, definitions }
      }).pipe(Effect.provide(runtime)),
    )

    expectLaunchIdentityFailure(result.approve)
    expectLaunchIdentityFailure(result.servers)
    expectLaunchIdentityFailure(result.definitions)
    expect(calls).toEqual([])
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

  test("returns discovered MCP tool definitions in deterministic name order", async () => {
    const runtime = layer(
      [
        userSource({
          zed: { url: "https://example.com/zed" },
          alpha: { url: "https://example.com/alpha" },
        }),
      ],
      fakeConnector({
        zed: { tools: [{ name: "write", inputSchema: { type: "object" } }] },
        alpha: { tools: [{ name: "read", inputSchema: { type: "object" } }] },
      }),
    )

    const definitions = await Effect.runPromise(McpClient.toolDefinitions().pipe(Effect.provide(runtime)))

    expect(definitions.map((definition) => definition.tool.name)).toEqual(["mcp.alpha.read", "mcp.zed.write"])
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
          Effect.provide(ToolExecutor.layer.pipe(Layer.provideMerge(diagnosticsLayer()))),
          Effect.provide(ToolRegistry.layerFromDefinitions(definitions)),
          Effect.provide(PermissionPolicy.rejectLayer("blocked by policy")),
        )
      }).pipe(Effect.provide(runtime)),
    )

    expect(result.status).toBe("error")
    expect(result.error?.kind).toBe("permission")
    expect(calls).toEqual(["connect:remote", "list:remote", "close:remote"])
  })

  test("resolves placeholders at connection time and registers non-suffix values for redaction", async () => {
    const previousHost = process.env.REMOTE_HOST
    const previousValue = process.env.REMOTE_VALUE
    process.env.REMOTE_HOST = "remote.example"
    process.env.REMOTE_VALUE = "remote-token-secret"
    const seen: Array<McpClient.ServerConfig> = []
    const calls: Array<string> = []
    const runtime = Layer.mergeAll(
      layer(
        [
          userSource({
            remote: {
              url: "https://${REMOTE_HOST}/mcp",
              headers: { authorization: "Bearer ${REMOTE_VALUE}" },
            },
          }),
        ],
        (server) => {
          seen.push(server.config)
          return fakeConnector(
            { remote: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
            calls,
          )(server)
        },
      ),
      SecretRedactor.layer,
    )

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const definitions = yield* McpClient.toolDefinitions()
          const redacted = yield* SecretRedactor.redact("token remote-token-secret")
          return { definitions, redacted }
        }).pipe(Effect.provide(runtime)),
      )

      expect(result.definitions.map((definition) => definition.tool.name)).toEqual(["mcp.remote.echo"])
      expect(seen).toEqual([
        {
          url: "https://remote.example/mcp",
          headers: { authorization: "Bearer remote-token-secret" },
        },
      ])
      expect(result.redacted).toBe("token [REDACTED:REMOTE_VALUE]")
      expect(calls).toEqual(["connect:remote", "list:remote", "close:remote"])
    } finally {
      if (previousHost === undefined) delete process.env.REMOTE_HOST
      else process.env.REMOTE_HOST = previousHost
      if (previousValue === undefined) delete process.env.REMOTE_VALUE
      else process.env.REMOTE_VALUE = previousValue
    }
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
          Layer.provideMerge(diagnosticsLayer()),
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
