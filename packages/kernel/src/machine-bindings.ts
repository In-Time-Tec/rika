import { MCPClient } from "generalist/mcp"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import type * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import type * as McpConfiguration from "@rika/extensions/mcp-configuration"
import { Context, Data, Effect, Layer, Schema } from "effect"

export type Services = CodingToolRuntime.Service | ShellProcessRegistry.Service | McpRuntime.McpRuntimeService

export type Request =
  | { readonly _tag: "CodingTool"; readonly request: CodingToolRuntime.Request }
  | { readonly _tag: "ProcessStop"; readonly processId: string }
  | { readonly _tag: "McpDiscover"; readonly server: McpConfiguration.Server }
  | {
      readonly _tag: "McpCall"
      readonly server: McpConfiguration.Server
      readonly tool: string
      readonly input: Schema.Json
    }

export type Outcome =
  | {
      readonly _tag: "Success"
      readonly value:
        | { readonly _tag: "CodingTool"; readonly result: import("@rika/coding-tools/coding-tool-result").Result }
        | { readonly _tag: "ProcessStopped" }
        | { readonly _tag: "McpDiscovered"; readonly tools: ReadonlyArray<MCPClient.DiscoveredTool> }
        | { readonly _tag: "McpCalled"; readonly content: MCPClient.JsonValue }
    }
  | {
      readonly _tag: "Failure"
      readonly failure:
        | CodingToolRuntime.ToolError
        | McpRuntime.Diagnostic
        | { readonly _tag: "ProcessStopFailed"; readonly message: string }
    }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Unknown"; readonly message: string }
  | { readonly _tag: "Fenced"; readonly message: string }

export class Unavailable extends Data.TaggedError("MachineBindingUnavailable")<{ readonly message: string }> {}

export interface Interface {
  readonly execute: (request: Request) => Effect.Effect<Outcome, Unavailable>
}

export class Client extends Context.Service<Client, Interface>()("@rika/kernel/machine-bindings/Client") {}

const cancelledTool = (request: CodingToolRuntime.Request) =>
  CodingToolRuntime.ToolError.make({
    tool: request._tag === "Shell" ? "bash" : request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
    message: "Cell operation was cancelled before the machine tool completed.",
    kind: "operation",
    category: "operation",
    outcome: "known",
    recovery: "never",
    nextAction: "Submit a new request if this work should continue",
  })

const uncertainTool = (request: CodingToolRuntime.Request, message: string) =>
  CodingToolRuntime.ToolError.make({
    tool: request._tag === "Shell" ? "bash" : request._tag.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
    message,
    kind: "operation",
    category: "operation",
    outcome: "unknown",
    recovery: "later",
    nextAction: "Retry this operation",
  })

const codingTools = Layer.effect(
  CodingToolRuntime.Service,
  Effect.map(Client, (client) =>
    CodingToolRuntime.Service.of({
      run: (request) =>
        client.execute({ _tag: "CodingTool", request }).pipe(
          Effect.flatMap((outcome): Effect.Effect<CodingToolResult.Result, CodingToolRuntime.ToolError> => {
            if (outcome._tag === "Success" && outcome.value._tag === "CodingTool")
              return Effect.succeed(outcome.value.result)
            if (outcome._tag === "Failure" && Schema.is(CodingToolRuntime.ToolError)(outcome.failure))
              return Effect.fail(outcome.failure)
            if (outcome._tag === "Cancelled") return Effect.fail(cancelledTool(request))
            return Effect.fail(uncertainTool(request, "machine coding-tool outcome is not safely observable"))
          }),
          Effect.catchTag("MachineBindingUnavailable", (error) => Effect.fail(uncertainTool(request, error.message))),
        ),
    }),
  ),
)

const processes = Layer.effect(
  ShellProcessRegistry.Service,
  Effect.map(Client, (client) =>
    ShellProcessRegistry.Service.of({
      start: () => Effect.die("process starts are routed through CodingToolRuntime"),
      poll: () => Effect.die("process polling is routed through CodingToolRuntime"),
      cancel: (processId) =>
        client.execute({ _tag: "ProcessStop", processId }).pipe(
          Effect.flatMap((outcome) => {
            if (outcome._tag === "Success" && outcome.value._tag === "ProcessStopped") return Effect.void
            if (outcome._tag === "Failure" && outcome.failure._tag === "ProcessStopFailed")
              return Effect.fail(new ShellProcessRegistry.ProcessNotFound({ message: outcome.failure.message }))
            if (outcome._tag === "Cancelled")
              return Effect.fail(
                new ShellProcessRegistry.ProcessNotFound({
                  message: `Cell operation was cancelled before process ${processId} was stopped`,
                }),
              )
            return Effect.fail(
              new ShellProcessRegistry.ProcessNotFound({
                message: "machine process-stop outcome is not safely observable",
              }),
            )
          }),
          Effect.catchTag("MachineBindingUnavailable", (error) =>
            Effect.fail(new ShellProcessRegistry.ProcessNotFound({ message: error.message })),
          ),
        ),
    }),
  ),
)

const mcp = Layer.effect(
  McpRuntime.McpRuntimeService,
  Effect.map(Client, (client) =>
    McpRuntime.McpRuntimeService.of({
      connect: (server) =>
        client.execute({ _tag: "McpDiscover", server }).pipe(
          Effect.flatMap((outcome): Effect.Effect<MCPClient.Service, McpRuntime.Diagnostic> => {
            if (outcome._tag === "Failure" && Schema.is(McpRuntime.Diagnostic)(outcome.failure))
              return Effect.fail(outcome.failure)
            if (outcome._tag === "Cancelled")
              return Effect.fail(
                McpRuntime.Diagnostic.make({
                  server: server.name,
                  phase: "discover",
                  message: "Cell operation was cancelled before MCP discovery completed",
                }),
              )
            if (outcome._tag !== "Success" || outcome.value._tag !== "McpDiscovered")
              return Effect.fail(
                McpRuntime.Diagnostic.make({
                  server: server.name,
                  phase: "discover",
                  message: "machine MCP discovery outcome is not safely observable",
                }),
              )
            const tools = outcome.value.tools
            return Effect.succeed(
              MCPClient.MCPClient.of({
                server: server.name,
                tools: Effect.succeed(tools),
                callTool: (tool, input) =>
                  client.execute({ _tag: "McpCall", server, tool, input }).pipe(
                    Effect.flatMap((result): Effect.Effect<MCPClient.JsonValue, MCPClient.MCPToolCallFailed> => {
                      if (result._tag === "Success" && result.value._tag === "McpCalled")
                        return Effect.succeed(result.value.content)
                      if (result._tag === "Failure" && Schema.is(McpRuntime.Diagnostic)(result.failure))
                        return Effect.fail(
                          MCPClient.MCPToolCallFailed.make({
                            server: server.name,
                            tool,
                            message: result.failure.message,
                          }),
                        )
                      if (result._tag === "Cancelled")
                        return Effect.fail(
                          MCPClient.MCPToolCallFailed.make({
                            server: server.name,
                            tool,
                            message: "Cell operation was cancelled before the MCP call completed",
                          }),
                        )
                      return Effect.fail(
                        MCPClient.MCPToolCallFailed.make({
                          server: server.name,
                          tool,
                          message: "machine MCP call outcome is not safely observable",
                        }),
                      )
                    }),
                    Effect.catchTag("MachineBindingUnavailable", (error) =>
                      Effect.fail(
                        MCPClient.MCPToolCallFailed.make({
                          server: server.name,
                          tool,
                          message: error.message,
                        }),
                      ),
                    ),
                  ),
                aiTools: Effect.succeed([]),
              }),
            )
          }),
          Effect.catchTag("MachineBindingUnavailable", (error) =>
            Effect.fail(
              McpRuntime.Diagnostic.make({
                server: server.name,
                phase: "discover",
                message: error.message,
              }),
            ),
          ),
        ),
    }),
  ),
)

export const layer = (client: Interface): Layer.Layer<Services> =>
  Layer.mergeAll(codingTools, processes, mcp).pipe(Layer.provide(Layer.succeed(Client, Client.of(client))))
