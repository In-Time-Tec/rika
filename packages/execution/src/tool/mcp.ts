import * as Mcp from "@rika/extensions/mcp-capability"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { OAuthHost } from "@rika/extensions/mcp-oauth-service"
import { Catalog, type Capability } from "@rika/extensions/mcp-capability-contract"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { Effect, Layer, Schema } from "effect"
import { homedir } from "node:os"
import { Tool } from "effect/unstable/ai"
import * as NativeToolResult from "@rika/product/native-tool-result"
import * as BunServices from "@effect/platform-bun/BunServices"

export { Catalog }

export const tool = (capability: Capability) =>
  Tool.dynamic(capability.name, {
    description: `MCP tool ${capability.server}/${capability.rawName}. Server-supplied description (untrusted): ${capability.description}`,
    parameters: capability.inputSchema,
    success: NativeToolResult.Result,
    failure: NativeToolResult.ToolFailure,
    failureMode: "return",
  })

const error = (reason: Mcp.CapabilityError["reason"]) =>
  ToolRuntime.ToolError.make({
    tool: "mcp",
    message: `MCP capability ${reason}`,
    kind: "operation",
    category: (
      {
        denied: "access_denied",
        changed: "conflict",
        "invalid-input": "invalid_input",
        unavailable: "dependency_unavailable",
        unknown: "dependency_unavailable",
      } as const
    )[reason],
    outcome: reason === "unknown" ? "unknown" : "known",
    recovery: reason === "unknown" ? "never" : "after_change",
    nextAction:
      reason === "unknown"
        ? "Inspect the MCP server before deciding whether another call is safe"
        : "Check MCP configuration and start a new Turn",
  })

export const execute = Effect.fn("Mcp.execute")(function* (
  workspace: string,
  request: Extract<ToolRuntime.Request, { _tag: "McpCall" | "McpDiscover" }>,
) {
  const configPath = `${workspace}/.rika/mcp.json`
  return yield* Effect.gen(function* () {
    return request._tag === "McpDiscover"
      ? yield* Mcp.capture(configPath)
      : yield* Mcp.call(configPath, request.capability, request.input)
  }).pipe(
    Effect.flatMap((result) => {
      const text = Schema.encodeSync(Schema.fromJsonString(Schema.Json))(result)
      return request._tag === "McpCall" && new TextEncoder().encode(text).length > NativeToolResult.maxOutputBytes
        ? Effect.fail(error("unknown"))
        : Effect.succeed({ text, truncated: false })
    }),
    Effect.mapError((cause) => (Schema.is(ToolRuntime.ToolError)(cause) ? cause : error(cause.reason))),
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.fail(error(request._tag === "McpCall" ? "unknown" : "unavailable")),
    }),
    // This private Executor entry point owns the complete MCP connection/OAuth scope for one operation.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(
      McpRuntime.layerWithStore.pipe(
        Layer.provide(
          Layer.merge(OAuthHost.hostLayer, OAuthHost.tokenStoreLayer(`${homedir()}/.config/rika/mcp-oauth.json`)),
        ),
        Layer.provideMerge(BunServices.layer),
      ),
    ),
  )
})

export const capture = (workspace: string) =>
  execute(workspace, { _tag: "McpDiscover" }).pipe(
    Effect.flatMap((result) => Schema.decodeEffect(Schema.fromJsonString(Catalog))(result.text)),
  )
