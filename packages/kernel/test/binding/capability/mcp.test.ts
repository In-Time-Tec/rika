import { describe, expect, it } from "@effect/vitest"
import { NestedOperation } from "tenetkit"
import { Context, Effect } from "effect"
import type * as McpDiscovery from "@rika/extensions/mcp-discovery"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import * as McpBinding from "@rika/kernel/mcp-binding"
import { journal, mountModules } from "../../support/binding"

const server = (name: string, enabled = true): McpDiscovery.ConfiguredServer => ({
  server: {
    kind: "local",
    name,
    command: "server",
    args: [],
    environment: {},
    source: "workspace",
    sourceDigest: "digest",
  },
  enabled,
})

const tool = (name: string) => ({
  name,
  rawName: `raw_${name}`,
  description: "",
  inputSchema: {},
  outputSchema: {},
})

const runtime = (tools: ReadonlyArray<ReturnType<typeof tool>>, calls: Array<string> = []) =>
  McpRuntime.McpRuntimeService.of({
    connect: () =>
      Effect.succeed({
        server: "files",
        tools: Effect.succeed(tools),
        callTool: (rawName: string) => {
          calls.push(rawName)
          return Effect.succeed({ ok: true })
        },
        aiTools: Effect.succeed([]),
      } as never),
  })

const registry = (
  servers: ReadonlyArray<McpDiscovery.ConfiguredServer>,
  service = runtime([tool("read")]),
  nested?: NestedOperation.Interface,
) =>
  mountModules({
    modules: [McpBinding.make(servers)],
    services: Context.make(McpRuntime.McpRuntimeService, service),
    nested,
  })

describe("mcp binding", () => {
  it.effect("mounts servers, tools, and call as the flat contract behind the proxy", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files")])
      expect(mounted.descriptors).toEqual([{ module: "mcp", operations: ["servers", "tools", "call"] }])
    }),
  )

  it.effect("lists server names only, so the prompt costs three words instead of forty schemas", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files"), server("search")])
      const response = yield* mounted.invoke({ module: "mcp", operation: "servers", input: {} })
      expect(response).toEqual({
        _tag: "Success",
        output: [
          { name: "files", kind: "local", enabled: true },
          { name: "search", kind: "local", enabled: true },
        ],
      })
    }),
  )

  it.effect("discovers tool schemas on demand", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files")], runtime([tool("read"), tool("write")]))
      const response = yield* mounted.invoke({ module: "mcp", operation: "tools", input: { server: "files" } })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success")
        expect((response.output as ReadonlyArray<{ name: string }>).map((entry) => entry.name)).toEqual([
          "read",
          "write",
        ])
    }),
  )

  it.effect("fails an unknown server as tagged data, never undefined is not a function", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files")])
      const response = yield* mounted.invoke({ module: "mcp", operation: "tools", input: { server: "ghost" } })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({ _tag: "McpBindingNotFound", module: "mcp.ghost" })
    }),
  )

  it.effect("fails an unknown tool on a known server as tagged data", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files")])
      const response = yield* mounted.invoke({
        module: "mcp",
        operation: "call",
        input: { server: "files", tool: "ghost", input: {} },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({
          _tag: "McpBindingNotFound",
          module: "mcp.files",
          operation: "ghost",
        })
    }),
  )

  it.effect("calls the discovered raw tool name rather than the model-facing alias", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const mounted = yield* registry([server("files")], runtime([tool("read")], calls))
      yield* mounted.invoke({
        module: "mcp",
        operation: "call",
        input: { server: "files", tool: "read", input: { path: "a" } },
      })
      expect(calls).toEqual(["raw_read"])
    }),
  )

  it.effect("reports a disabled server and refuses to reach it", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files"), server("legacy", false)])
      const listed = yield* mounted.invoke({ module: "mcp", operation: "servers", input: {} })
      expect(listed).toEqual({
        _tag: "Success",
        output: [
          { name: "files", kind: "local", enabled: true },
          { name: "legacy", kind: "local", enabled: false },
        ],
      })
      const response = yield* mounted.invoke({ module: "mcp", operation: "tools", input: { server: "legacy" } })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({
          _tag: "McpBindingNotFound",
          module: "mcp.legacy",
          message: "MCP server legacy is disabled in this Workspace",
        })
    }),
  )

  it.effect("names only reachable servers when an unknown server is asked for", () =>
    Effect.gen(function* () {
      const mounted = yield* registry([server("files"), server("legacy", false)])
      const response = yield* mounted.invoke({ module: "mcp", operation: "tools", input: { server: "ghost" } })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({
          _tag: "McpBindingNotFound",
          message: "No MCP server named ghost is configured. Configured servers: files",
        })
    }),
  )

  it.effect("journals a call as never-replay with approval and leaves discovery alone", () =>
    Effect.gen(function* () {
      const recorder = journal()
      const mounted = yield* registry([server("files")], runtime([tool("read")]), recorder.nested)
      yield* mounted.invoke({ module: "mcp", operation: "servers", input: {} })
      yield* mounted.invoke({ module: "mcp", operation: "tools", input: { server: "files" } })
      yield* mounted.invoke({
        module: "mcp",
        operation: "call",
        input: { server: "files", tool: "read", input: {} },
      })
      expect(recorder.kinds).toEqual(["mcp.call"])
      expect(recorder.policies).toEqual(["never"])
      expect(recorder.approvals).toEqual(["mcp.call"])
    }),
  )
})
