import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "@batonfx/repl"
import type * as McpDiscovery from "@rika/extensions/mcp-discovery"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "mcp"

/**
 * Shaped like Baton's HostBindingNotFound so an unknown server or tool reaches the cell as tagged
 * data. The bootstrap Proxy over `rika.mcp.<server>.<tool>` resolves names lazily, so this is the
 * only thing standing between a typo and `undefined is not a function`.
 */
export class McpBindingNotFound extends Schema.TaggedErrorClass<McpBindingNotFound>()("McpBindingNotFound", {
  module: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export class McpCallFailed extends Schema.TaggedErrorClass<McpCallFailed>()("McpCallFailed", {
  server: Schema.String,
  phase: Schema.Literals(["connect", "discover", "call"]),
  message: Schema.String,
}) {}

const Failure = Schema.Union([McpBindingNotFound, McpCallFailed, NestedOperationFailed])

const Empty = Schema.Struct({})

const Server = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["local", "remote"]),
  enabled: Schema.Boolean,
})

const Tool = Schema.Struct({
  name: Schema.String,
  rawName: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Json,
  outputSchema: Schema.Json,
})

const ToolsInput = Schema.Struct({ server: Schema.String.check(Schema.isNonEmpty()) })
const CallInput = Schema.Struct({
  server: Schema.String.check(Schema.isNonEmpty()),
  tool: Schema.String.check(Schema.isNonEmpty()),
  input: Schema.Json,
})
const Called = Schema.Struct({ content: Schema.Json, isError: Schema.Boolean })

export const make = (
  servers: ReadonlyArray<McpDiscovery.ConfiguredServer>,
): HostBindingRegistry.Module<McpRuntime.McpRuntimeService | Requirements> => {
  const configured = new Map(servers.map((entry) => [entry.server.name, entry] as const))
  const reachable = servers.filter((entry) => entry.enabled).map((entry) => entry.server.name)
  const resolve = (server: string) => {
    const found = configured.get(server)
    if (found === undefined)
      return Effect.fail(
        McpBindingNotFound.make({
          module: `mcp.${server}`,
          message: `No MCP server named ${server} is configured. Configured servers: ${reachable.join(", ") || "none"}`,
        }),
      )
    return found.enabled
      ? Effect.succeed(found.server)
      : Effect.fail(
          McpBindingNotFound.make({
            module: `mcp.${server}`,
            message: `MCP server ${server} is disabled in this Workspace`,
          }),
        )
  }
  const diagnostic = (error: McpRuntime.Diagnostic) =>
    McpCallFailed.make({ server: error.server, phase: error.phase, message: error.message })

  return {
    name,
    operations: [
      operation({
        name: "servers",
        input: Empty,
        output: Schema.Array(Server),
        failure: Failure,
        handle: () =>
          Effect.succeed(
            servers.map((entry) => ({ name: entry.server.name, kind: entry.server.kind, enabled: entry.enabled })),
          ),
      }),
      operation({
        name: "tools",
        input: ToolsInput,
        output: Schema.Array(Tool),
        failure: Failure,
        handle: (input) =>
          Effect.flatMap(resolve(input.server), (server) =>
            Effect.scoped(McpRuntime.discover(server)).pipe(Effect.mapError(diagnostic)),
          ),
      }),
      operation({
        name: "call",
        input: CallInput,
        output: Called,
        failure: Failure,
        handle: (input) =>
          nested(
            {
              kind: "mcp.call",
              payload: input,
              replayPolicy: "never",
              approval: { capability: "mcp.call", request: { server: input.server, tool: input.tool } },
            },
            Effect.flatMap(resolve(input.server), (server) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const discovered = yield* McpRuntime.discover(server)
                  const tool = discovered.find(
                    (candidate) => candidate.name === input.tool || candidate.rawName === input.tool,
                  )
                  if (tool === undefined)
                    return yield* McpBindingNotFound.make({
                      module: `mcp.${input.server}`,
                      operation: input.tool,
                      message: `Server ${input.server} exposes no tool named ${input.tool}`,
                    })
                  return yield* McpRuntime.call(server, tool.rawName, input.input)
                }),
              ).pipe(
                Effect.mapError((error) => (error._tag === "McpBindingNotFound" ? error : diagnostic(error))),
                Effect.map((content) => ({ content, isError: false })),
              ),
            ),
          ),
      }),
    ],
  }
}
