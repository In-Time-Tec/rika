import * as BunServices from "@effect/platform-bun/BunServices"
import { McpToolSource } from "@batonfx/mcp"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { McpConfig, McpRuntime, McpTrust } from "../src"
import { provideLayer } from "./layer"

const local = JSON.stringify({
  servers: { shell: { command: "runner", args: ["--mcp"], env: { TOKEN: "secret", HOME: "/home" }, cwd: "tools" } },
})

it.effect("skill MCP configuration is composed only from activated skill resources", () =>
  Effect.gen(function* () {
    const hidden = yield* McpConfig.compose({})
    const visible = yield* McpConfig.compose({
      activatedSkills: [
        {
          name: "review",
          digest: "skill-digest",
          resources: [{ path: "mcp.json", content: '{"docs":{"url":"https://example.test/mcp"}}' }],
        },
      ],
    })
    expect(hidden).toEqual([])
    expect(visible).toEqual([
      {
        kind: "remote",
        name: "docs",
        url: "https://example.test/mcp",
        headers: {},
        source: "skill:review",
        sourceDigest: "skill-digest",
      },
    ])
  }).pipe(provideLayer(BunServices.layer)),
)

it.effect("trust fingerprints include names and configuration but never environment values", () =>
  Effect.gen(function* () {
    const [server] = yield* McpConfig.compose({ workspace: local })
    if (server === undefined || server.kind !== "local") return yield* Effect.die("Expected local server")
    const trust = yield* McpTrust.Service
    const record = yield* trust.create("workspace-id", "/workspace", server)
    const before = yield* trust.isTrusted(record)
    yield* trust.approve(record)
    const after = yield* trust.isTrusted(record)
    expect(before).toBe(false)
    expect(after).toBe(true)
    expect(record.effectiveCwd).toBe("/workspace/tools")
    expect(Object.values(record).join(" ")).not.toContain("secret")
    expect(record.environmentNameFingerprint).toHaveLength(64)
  }).pipe(provideLayer(Layer.merge(McpTrust.layer.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
)

it.effect("runtime discovers and calls through a deterministic Baton MCP tool source", () => {
  const source = McpToolSource.McpToolSource.of({
    server: "docs",
    tools: Effect.succeed([
      { name: "docs_find", rawName: "find", description: "Find", inputSchema: {}, outputSchema: {} },
    ]),
    callTool: (_name, input) => Effect.succeed(input),
    aiTools: Effect.succeed([]),
  })
  const server: McpConfig.RemoteServer = {
    kind: "remote",
    name: "docs",
    url: "https://example.test/mcp",
    headers: {},
    source: "workspace",
    sourceDigest: "digest",
  }
  return Effect.gen(function* () {
    const result = yield* provideLayer(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* McpRuntime.discover(server)
          const output = yield* McpRuntime.call(server, "find", { query: "rika" })
          return { tools, output }
        }),
      ),
      McpRuntime.testLayer(() => Effect.succeed(source)),
    )
    expect(result.tools.map((tool) => tool.name)).toEqual(["docs_find"])
    expect(result.output).toEqual({ query: "rika" })
  })
})
