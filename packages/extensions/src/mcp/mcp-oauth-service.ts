import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { OAuth } from "@batonfx/mcp"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Function,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Scope,
} from "effect"
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

interface McpOAuthServiceInterface {
  readonly login: (server: string, url: string) => Effect.Effect<void, McpOAuthError>
  readonly logout: (server: string, url: string) => Effect.Effect<void, McpOAuthError>
  readonly status: (server: string, url: string) => Effect.Effect<"authenticated" | "unauthenticated", McpOAuthError>
}

export class McpOAuthService extends Context.Service<McpOAuthService, McpOAuthServiceInterface>()(
  "@rika/extensions/mcp/mcp-oauth-service/McpOAuthService",
) {}

const redirectUrl = "http://127.0.0.1:17839/oauth/callback"

const service = (
  oauth: (server: string, url: string) => Effect.Effect<OAuthClient>,
): Effect.Effect<McpOAuthServiceInterface, never, Host | OAuth.TokenStore> =>
  Effect.gen(function* () {
    const host = yield* Host
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
): Layer.Layer<McpOAuthService, never, Host | OAuth.TokenStore> => Layer.effect(McpOAuthService, service(oauth))

export const layer: Layer.Layer<McpOAuthService, never, Crypto.Crypto | Host | OAuth.TokenStore> = Layer.effect(
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

class McpOAuthHostError extends Schema.TaggedErrorClass<McpOAuthHostError>()("@rika/extensions/McpOAuthHostError", {
  server: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

interface HostInterface {
  readonly open: (url: string) => Effect.Effect<void, McpOAuthHostError>
  readonly callback: (
    redirectUrl: string,
    expectedState: string,
  ) => Effect.Effect<Effect.Effect<string, McpOAuthHostError>, McpOAuthHostError, Scope.Scope>
}

class Host extends Context.Service<Host, HostInterface>()("@rika/extensions/mcp/mcp-oauth-service/Host") {}

const hostTestLayer = (implementation: HostInterface) => Layer.succeed(Host, Host.of(implementation))

interface BrowserCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

const browserCommandImpl = (platform: NodeJS.Platform, url: string): BrowserCommand => {
  let command = "xdg-open"
  if (platform === "darwin") command = "open"
  else if (platform === "win32") command = "cmd"
  return {
    command,
    args: platform === "win32" ? ["/c", "start", "", url] : [url],
  }
}

const browserCommand: {
  (url: string): (platform: NodeJS.Platform) => BrowserCommand
  (platform: NodeJS.Platform, url: string): BrowserCommand
} = Function.dual(2, browserCommandImpl)

const hostLayer = Layer.effect(
  Host,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return Host.of({
      open: Effect.fn("McpOAuthHost.open")((url) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { command, args } = browserCommand(process.platform, url)
            const child = yield* spawner
              .spawn(ChildProcess.make(command, args, { stdout: "ignore", stderr: "ignore" }))
              .pipe(
                Effect.mapError(() =>
                  McpOAuthHostError.make({
                    server: "system-browser",
                    operation: "open-browser",
                    message: "Unable to open the system browser",
                  }),
                ),
              )
            const exitCode = yield* child.exitCode.pipe(
              Effect.mapError(() =>
                McpOAuthHostError.make({
                  server: "system-browser",
                  operation: "open-browser",
                  message: "Unable to open the system browser",
                }),
              ),
            )
            if (exitCode !== 0)
              return yield* McpOAuthHostError.make({
                server: "system-browser",
                operation: "open-browser",
                message: "Unable to open the system browser",
              })
          }),
        ),
      ),
      callback: Effect.fn("McpOAuthHost.callback")((callbackUrl, expectedState) =>
        Effect.gen(function* () {
          const target = yield* Effect.try({
            try: () => new URL(callbackUrl),
            catch: () =>
              McpOAuthHostError.make({
                server: callbackUrl,
                operation: "callback",
                message: "Unable to bind the OAuth callback",
              }),
          })
          const completed = yield* Deferred.make<string>()
          const server = yield* BunHttpServer.make({
            hostname: target.hostname,
            port: Number(target.port),
          }).pipe(
            Effect.catchCause(() =>
              Effect.fail(
                McpOAuthHostError.make({
                  server: callbackUrl,
                  operation: "callback",
                  message: "Unable to bind the OAuth callback",
                }),
              ),
            ),
          )
          const app = Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const url = new URL(request.url, target)
            if (url.pathname !== target.pathname) return HttpServerResponse.text("Not found", { status: 404 })
            if (url.searchParams.get("state") !== expectedState)
              return HttpServerResponse.text("Invalid OAuth callback state.", { status: 400 })
            yield* Deferred.succeed(completed, url.toString())
            return HttpServerResponse.text("Authentication complete. You may close this window.")
          })
          yield* server.serve(app)
          return completed
        }).pipe(Effect.map(Deferred.await)),
      ),
    })
  }),
)

const tokenStoreFailure = (server: string, operation: string) =>
  OAuth.OAuthProviderError.make({ server, operation, message: `OAuth token ${operation} failed` })

const tokenStoreLayer = (filename: string): Layer.Layer<OAuth.TokenStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    OAuth.TokenStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const read = Effect.fn("McpOAuthTokenStore.read")(() =>
        fileSystem.exists(filename).pipe(
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.chmod(filename, 0o600).pipe(Effect.andThen(fileSystem.readFileString(filename)))
              : Effect.succeed("{}"),
          ),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))),
          ),
        ),
      )
      return OAuth.TokenStore.of({
        load: Effect.fn("McpOAuthTokenStore.load")((server) =>
          read().pipe(
            Effect.map((values) =>
              values[server] === undefined ? Option.none() : Option.some(Redacted.make(values[server])),
            ),
            Effect.mapError(() => tokenStoreFailure(server, "load")),
          ),
        ),
        save: Effect.fn("McpOAuthTokenStore.save")((server, tokens) =>
          read().pipe(
            Effect.flatMap((values) =>
              fileSystem.makeDirectory(path.dirname(filename), { recursive: true }).pipe(
                Effect.andThen(
                  fileSystem.writeFileString(
                    filename,
                    Schema.encodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))({
                      ...values,
                      [server]: Redacted.value(tokens),
                    }),
                    { mode: 0o600 },
                  ),
                ),
                Effect.andThen(fileSystem.chmod(filename, 0o600)),
              ),
            ),
            Effect.mapError(() => tokenStoreFailure(server, "save")),
          ),
        ),
        remove: Effect.fn("McpOAuthTokenStore.remove")((server) =>
          read().pipe(
            Effect.flatMap((values) => {
              const remaining = Object.fromEntries(Object.entries(values).filter(([name]) => name !== server))
              return fileSystem
                .makeDirectory(path.dirname(filename), { recursive: true })
                .pipe(
                  Effect.andThen(
                    fileSystem.writeFileString(
                      filename,
                      Schema.encodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(remaining),
                      { mode: 0o600 },
                    ),
                  ),
                  Effect.andThen(fileSystem.chmod(filename, 0o600)),
                )
            }),
            Effect.mapError(() => tokenStoreFailure(server, "remove")),
          ),
        ),
      })
    }),
  )

export const OAuthHost = {
  Host,
  McpOAuthHostError,
  hostTestLayer,
  browserCommand,
  hostLayer,
  tokenStoreLayer,
}
