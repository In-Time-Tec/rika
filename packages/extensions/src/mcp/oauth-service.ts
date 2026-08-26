import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { OAuth } from "tenetkit/mcp"
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
  Ref,
  Schema,
  Scope,
} from "effect"
export class McpOAuthError extends Schema.TaggedError<McpOAuthError>()("@rika/extensions/McpOAuthError", {
  server: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface OAuthClient {
  readonly authorize: Effect.Effect<OAuth.Authorization, OAuth.OAuthProviderError>
  readonly callback: (url: string) => Effect.Effect<void, OAuthClientError>
  readonly clear: Effect.Effect<void, OAuth.OAuthProviderError>
}

interface PreparedCallback {
  readonly redirectUrl: string
  readonly wait: (expectedState: string) => Effect.Effect<string, McpOAuthHostError>
}

export type OAuthClientError = OAuth.OAuthDenied | OAuth.OAuthExpired | OAuth.OAuthProviderError

interface McpOAuthServiceInterface {
  readonly login: (server: string, url: string) => Effect.Effect<void, McpOAuthError>
  readonly logout: (server: string, url: string) => Effect.Effect<void, McpOAuthError>
  readonly status: (server: string, url: string) => Effect.Effect<"authenticated" | "unauthenticated", McpOAuthError>
}

export class McpOAuthService extends Context.Service<McpOAuthService, McpOAuthServiceInterface>()(
  "@rika/extensions/mcp/oauth-service/McpOAuthService",
) {}

const callbackPath = "/oauth/callback"

const service = (
  oauth: (server: string, url: string, redirectUrl: string) => Effect.Effect<OAuthClient>,
): Effect.Effect<McpOAuthServiceInterface, never, Host | OAuth.TokenStore> =>
  Effect.gen(function* () {
    const host = yield* Host
    const store = yield* OAuth.TokenStore
    const map = (server: string, operation: string) =>
      Effect.mapError((cause: unknown) => {
        let detail = `OAuth ${operation} failed`
        const decoded = Schema.decodeUnknownOption(
          Schema.Union([OAuth.OAuthExpired, OAuth.OAuthDenied, OAuth.OAuthProviderError]),
        )(cause)
        if (Option.isSome(decoded)) {
          if (decoded.value._tag === "tenetkit/mcp/OAuthExpired") detail = "OAuth callback state is invalid or expired"
          else if (decoded.value._tag === "tenetkit/mcp/OAuthDenied") detail = "OAuth authorization was denied"
          else detail = `OAuth ${decoded.value.operation} failed`
        }
        return McpOAuthError.make({ server, operation, message: detail })
      })
    return {
      login: Effect.fn("McpOAuthService.login")((server, url) =>
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* host.prepareCallback(callbackPath).pipe(map(server, "login"))
            const client = yield* oauth(server, url, prepared.redirectUrl).pipe(map(server, "login"))
            const authorization = yield* client.authorize.pipe(map(server, "login"))
            yield* host.open(authorization.url).pipe(map(server, "login"))
            const callbackUrl = yield* prepared.wait(authorization.state).pipe(map(server, "login"))
            yield* client.callback(callbackUrl).pipe(map(server, "login"))
          }),
        ),
      ),
      logout: Effect.fn("McpOAuthService.logout")(function* (server, url) {
        const client = yield* oauth(server, url, "http://127.0.0.1").pipe(map(server, "logout"))
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
  oauth: (server: string, url: string, redirectUrl: string) => Effect.Effect<OAuthClient>,
): Layer.Layer<McpOAuthService, never, Host | OAuth.TokenStore> => Layer.effect(McpOAuthService, service(oauth))

export const layer: Layer.Layer<McpOAuthService, never, Crypto.Crypto | Host | OAuth.TokenStore> = Layer.effect(
  McpOAuthService,
  Effect.gen(function* () {
    const store = yield* OAuth.TokenStore
    const crypto = yield* Crypto.Crypto
    const oauth = (_server: string, url: string, redirectUrl: string) =>
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

class McpOAuthHostError extends Schema.TaggedError<McpOAuthHostError>()("@rika/extensions/McpOAuthHostError", {
  server: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

interface HostInterface {
  readonly open: (url: string) => Effect.Effect<void, McpOAuthHostError>
  readonly prepareCallback: (path: string) => Effect.Effect<PreparedCallback, McpOAuthHostError, Scope.Scope>
}

export class Host extends Context.Service<Host, HostInterface>()("@rika/extensions/mcp/oauth-service/Host") {}

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

const hostLayer: Layer.Layer<Host, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
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
      prepareCallback: Effect.fn("McpOAuthHost.prepareCallback")((path) =>
        Effect.gen(function* () {
          const completed = yield* Deferred.make<string>()
          const expected = yield* Ref.make<string | undefined>(undefined)
          const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 }).pipe(
            Effect.catchCause(() =>
              Effect.fail(
                McpOAuthHostError.make({
                  server: path,
                  operation: "callback",
                  message: "Unable to bind the OAuth callback",
                }),
              ),
            ),
          )
          const address = server.address
          if (address._tag !== "TcpAddress")
            return yield* McpOAuthHostError.make({
              server: path,
              operation: "callback",
              message: "Unable to bind the OAuth callback",
            })
          const target = new URL(`http://127.0.0.1:${address.port}${path}`)
          const app = Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const url = new URL(request.url, target)
            if (url.pathname !== target.pathname) return HttpServerResponse.text("Not found", { status: 404 })
            const expectedState = yield* Ref.get(expected)
            if (expectedState === undefined || url.searchParams.get("state") !== expectedState)
              return HttpServerResponse.text("Invalid OAuth callback state.", { status: 400 })
            yield* Deferred.succeed(completed, url.toString())
            return HttpServerResponse.text("Authentication complete. You may close this window.")
          })
          yield* server.serve(app)
          return {
            redirectUrl: target.toString(),
            wait: (expectedState: string) =>
              Ref.set(expected, expectedState).pipe(
                Effect.andThen(Deferred.await(completed)),
                Effect.flatMap((value) => {
                  const url = new URL(value)
                  return url.searchParams.get("state") === expectedState
                    ? Effect.succeed(value)
                    : Effect.fail(
                        McpOAuthHostError.make({
                          server: target.toString(),
                          operation: "callback",
                          message: "Invalid OAuth callback state",
                        }),
                      )
                }),
              ),
          } satisfies PreparedCallback
        }),
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
