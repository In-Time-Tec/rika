import { McpToolSource, OAuth } from "@batonfx/mcp"
import { Context, Crypto, Effect, Layer, Schema, Scope } from "effect"
import type { Server } from "./mcp-configuration"

export class Diagnostic extends Schema.TaggedErrorClass<Diagnostic>()("@rika/extensions/McpDiagnostic", {
  server: Schema.String,
  phase: Schema.Literals(["connect", "discover", "call"]),
  message: Schema.String,
}) {}

export interface McpRuntimeInterface {
  readonly connect: (server: Server) => Effect.Effect<McpToolSource.Interface, Diagnostic, Scope.Scope>
}

export class McpRuntimeService extends Context.Service<McpRuntimeService, McpRuntimeInterface>()(
  "@rika/extensions/mcp-runtime/McpRuntimeService",
) {}

export const layerWithStore = Layer.effect(
  McpRuntimeService,
  Effect.gen(function* () {
    const store = yield* OAuth.TokenStore
    const crypto = yield* Crypto.Crypto
    return McpRuntimeService.of({
      connect: Effect.fn("McpRuntime.connect")(function* (server: Server) {
        const oauth =
          server.kind === "remote"
            ? yield* Layer.build(
                OAuth.layer({
                  serverUrl: server.url,
                  redirectUrl: "http://127.0.0.1:17839/oauth/callback",
                  clientMetadata: { redirect_uris: ["http://127.0.0.1:17839/oauth/callback"], client_name: "Rika" },
                }),
              ).pipe(
                Effect.map((context) => Context.get(context, OAuth.OAuth)),
                Effect.provideService(OAuth.TokenStore, store),
                Effect.provideService(Crypto.Crypto, crypto),
              )
            : undefined
        return yield* Layer.build(
          McpToolSource.layer({
            name: server.name,
            transport:
              server.kind === "local"
                ? { kind: "stdio", command: server.command, args: server.args, env: { ...server.environment } }
                : {
                    kind: "http",
                    url: server.url,
                    headers: { ...server.headers },
                    oauth: oauth!,
                  },
          }),
        ).pipe(
          Effect.map((context) => Context.get(context, McpToolSource.McpToolSource)),
          Effect.mapError((error) =>
            Diagnostic.make({ server: server.name, phase: "connect", message: error.message }),
          ),
        )
      }),
    })
  }),
)

export const layer = layerWithStore.pipe(Layer.provide(OAuth.layerTokenStoreMemory))

export const testLayer = (connect: McpRuntimeInterface["connect"]) =>
  Layer.succeed(McpRuntimeService, McpRuntimeService.of({ connect }))

export const discover = Effect.fn("McpRuntime.discover")(function* (server: Server) {
  const runtime = yield* McpRuntimeService
  const source = yield* runtime.connect(server)
  return yield* source.tools.pipe(
    Effect.map((tools) => tools.toSorted((left, right) => left.name.localeCompare(right.name))),
    Effect.mapError((error) => Diagnostic.make({ server: server.name, phase: "discover", message: String(error) })),
  )
})

export const call = Effect.fn("McpRuntime.call")(function* (
  server: Server,
  tool: string,
  input: McpToolSource.JsonValue,
) {
  const runtime = yield* McpRuntimeService
  const source = yield* runtime.connect(server)
  return yield* source
    .callTool(tool, input)
    .pipe(Effect.mapError((error) => Diagnostic.make({ server: server.name, phase: "call", message: error.message })))
})
