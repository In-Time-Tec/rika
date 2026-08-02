import * as BunServices from "@effect/platform-bun/BunServices"
import { McpToolSource } from "@batonfx/mcp"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as McpConfig from "@rika/extensions/mcp-configuration"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { provideLayer } from "../support/extension-test-layer"

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
