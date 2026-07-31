import { OAuth } from "@batonfx/mcp"
import { Context, Crypto, Effect, Layer, Option, Schema } from "effect"
import * as McpOAuthStore from "./mcp-oauth-store"
export class McpOAuthError extends Schema.TaggedErrorClass<McpOAuthError>()("@rika/extensions/McpOAuthError", {
  server: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface OAuthClient {
  readonly authorize: Effect.Effect<OAuth.Authorization, OAuth.OAuthProviderError>
  readonly callback: (url: string) => Effect.Effect<void, OAuthClientError>
  readonly clear: Effect.Effect<void, OAuth.OAuthProviderError>
}

export type OAuthClientError = OAuth.OAuthDenied | OAuth.OAuthExpired | OAuth.OAuthProviderError

export interface McpOAuthServiceInterface {
  readonly login: (server: string, url: string) => Effect.Effect<void, McpOAuthError>
  readonly logout: (server: string, url: string) => Effect.Effect<void, McpOAuthError>
  readonly status: (server: string, url: string) => Effect.Effect<"authenticated" | "unauthenticated", McpOAuthError>
}

export class McpOAuthService extends Context.Service<McpOAuthService, McpOAuthServiceInterface>()(
  "@rika/extensions/mcp-oauth-service/McpOAuthService",
) {}

const redirectUrl = "http://127.0.0.1:17839/oauth/callback"

const service = (
  oauth: (server: string, url: string) => Effect.Effect<OAuthClient>,
): Effect.Effect<McpOAuthServiceInterface, never, McpOAuthStore.Host | OAuth.TokenStore> =>
  Effect.gen(function* () {
    const host = yield* McpOAuthStore.Host
    const store = yield* OAuth.TokenStore
    const map = (server: string, operation: string) =>
      Effect.mapError((cause: unknown) => {
        let detail = `OAuth ${operation} failed`
        if (typeof cause === "object" && cause !== null && "_tag" in cause) {
          if (cause._tag === "@batonfx/mcp/OAuthExpired") detail = "OAuth callback state is invalid or expired"
          else if (cause._tag === "@batonfx/mcp/OAuthDenied") detail = "OAuth authorization was denied"
          else if (
            cause._tag === "@batonfx/mcp/OAuthProviderError" &&
            "operation" in cause &&
            typeof cause.operation === "string"
          )
            detail = `OAuth ${cause.operation} failed`
        }
        return McpOAuthError.make({ server, operation, message: detail })
      })
    return {
      login: Effect.fn("McpOAuthService.login")((server, url) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* oauth(server, url).pipe(map(server, "login"))
            const authorization = yield* client.authorize.pipe(map(server, "login"))
            const callback = yield* host.callback(redirectUrl, authorization.state).pipe(map(server, "login"))
            yield* host.open(authorization.url).pipe(map(server, "login"))
            const callbackUrl = yield* callback.pipe(map(server, "login"))
            yield* client.callback(callbackUrl).pipe(map(server, "login"))
          }),
        ),
      ),
      logout: Effect.fn("McpOAuthService.logout")(function* (server, url) {
        const client = yield* oauth(server, url).pipe(map(server, "logout"))
        yield* client.clear.pipe(map(server, "logout"))
      }),
      status: Effect.fn("McpOAuthService.status")((server, url) =>
        store.load(url).pipe(
          Effect.map((value) => (Option.isSome(value) ? ("authenticated" as const) : ("unauthenticated" as const))),
          map(server, "status"),
        ),
      ),
    }
  })

export const layerWithClient = (
  oauth: (server: string, url: string) => Effect.Effect<OAuthClient>,
): Layer.Layer<McpOAuthService, never, McpOAuthStore.Host | OAuth.TokenStore> =>
  Layer.effect(McpOAuthService, service(oauth))

export const layer: Layer.Layer<McpOAuthService, never, Crypto.Crypto | McpOAuthStore.Host | OAuth.TokenStore> =
  Layer.effect(
    McpOAuthService,
    Effect.gen(function* () {
      const store = yield* OAuth.TokenStore
      const crypto = yield* Crypto.Crypto
      const oauth = (_server: string, url: string) =>
        Effect.scoped(
          Layer.build(
            OAuth.layer({
              serverUrl: url,
              redirectUrl,
              clientMetadata: { redirect_uris: [redirectUrl], client_name: "Rika" },
            }),
          ).pipe(
            Effect.map((context) => {
              const client = Context.get(context, OAuth.OAuth)
              return {
                authorize: client.authorize,
                callback: client.callback,
                clear: client.clear,
              }
            }),
            Effect.provideService(OAuth.TokenStore, store),
            Effect.provideService(Crypto.Crypto, crypto),
          ),
        )
      return yield* service(oauth)
    }),
  )

export const testLayer = (implementation: McpOAuthServiceInterface) =>
  Layer.succeed(McpOAuthService, McpOAuthService.of(implementation))
