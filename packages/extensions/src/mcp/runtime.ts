import { MCPClient, OAuth } from "tenetkit/mcp"
import * as MCPHttp from "tenetkit/mcp/client/http"
import * as MCPStdio from "tenetkit/mcp/client/stdio"
import { Context, Crypto, Effect, Layer, Schema, Scope } from "effect"
import type { Server } from "./configuration"
import * as McpOAuth from "./oauth-service"
import { Host } from "./oauth-service"

export class Diagnostic extends Schema.TaggedError<Diagnostic>()("@rika/extensions/McpDiagnostic", {
  server: Schema.String,
  phase: Schema.Literals(["connect", "discover", "call"]),
  message: Schema.String,
}) {}

export interface McpRuntimeInterface {
  readonly connect: (server: Server) => Effect.Effect<MCPClient.Service, Diagnostic, Scope.Scope>
}

export class McpRuntimeService extends Context.Service<McpRuntimeService, McpRuntimeInterface>()(
  "@rika/extensions/mcp/runtime/McpRuntimeService",
) {}

export const layerWithStore: Layer.Layer<McpRuntimeService, never, OAuth.TokenStore | Crypto.Crypto | Host> =
  Layer.effect(
    McpRuntimeService,
    Effect.gen(function* () {
      const store = yield* OAuth.TokenStore
      const crypto = yield* Crypto.Crypto
      const host = yield* McpOAuth.OAuthHost.Host
      return McpRuntimeService.of({
        connect: Effect.fn("McpRuntime.connect")(function* (server: Server) {
          let oauth: OAuth.Service | undefined
          if (server.kind === "remote") {
            const callback = yield* host
              .prepareCallback("/oauth/callback")
              .pipe(
                Effect.mapError((error) =>
                  Diagnostic.make({ server: server.name, phase: "connect", message: error.message }),
                ),
              )
            oauth = yield* Layer.build(
              OAuth.layer({
                serverUrl: server.url,
                redirectUrl: callback.redirectUrl,
                clientMetadata: { redirect_uris: [callback.redirectUrl], client_name: "Rika" },
              }),
            ).pipe(
              Effect.map((context) => Context.get(context, OAuth.OAuth)),
              Effect.provideService(OAuth.TokenStore, store),
              Effect.provideService(Crypto.Crypto, crypto),
            )
          }
          return yield* Layer.build(
            server.kind === "local"
              ? MCPStdio.layer({
                  name: server.name,
                  transport: { command: server.command, args: server.args, env: { ...server.environment } },
                })
              : MCPHttp.layer({
                  name: server.name,
                  transport: {
                    url: server.url,
                    requestInit: { headers: { ...server.headers } },
                    oauth: oauth!,
                  },
                }),
          ).pipe(
            Effect.map((context) => Context.get(context, MCPClient.MCPClient)),
            Effect.mapError((error) =>
              Diagnostic.make({ server: server.name, phase: "connect", message: error.message }),
            ),
          )
        }),
      })
    }),
  )

export const layer = layerWithStore.pipe(
  Layer.provide(OAuth.layerTokenStoreMemory),
  Layer.provide(McpOAuth.OAuthHost.hostLayer),
)

export const testLayer = (connect: McpRuntimeInterface["connect"]) =>
  Layer.succeed(McpRuntimeService, McpRuntimeService.of({ connect }))

export const discover: (
  server: Server,
) => Effect.Effect<ReadonlyArray<MCPClient.DiscoveredTool>, Diagnostic, McpRuntimeService | Scope.Scope> = Effect.fn(
  "McpRuntime.discover",
)(function* (server: Server) {
  const runtime = yield* McpRuntimeService
  const source = yield* runtime.connect(server)
  return yield* source.tools.pipe(
    Effect.map((tools) => tools.toSorted((left, right) => left.name.localeCompare(right.name))),
    Effect.mapError((error) => Diagnostic.make({ server: server.name, phase: "discover", message: String(error) })),
  )
})

export const call = Effect.fn("McpRuntime.call")(function* (server: Server, tool: string, input: MCPClient.JsonValue) {
  const runtime = yield* McpRuntimeService
  const source = yield* runtime.connect(server)
  return yield* source
    .callTool(tool, input)
    .pipe(Effect.mapError((error) => Diagnostic.make({ server: server.name, phase: "call", message: error.message })))
})
