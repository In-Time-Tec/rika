import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { OAuth } from "@batonfx/mcp"
import { Context, Deferred, Effect, FileSystem, Function, Layer, Option, Path, Redacted, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class Error extends Schema.TaggedErrorClass<Error>()("@rika/extensions/McpOAuthError", {
  server: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface HostInterface {
  readonly open: (url: string) => Effect.Effect<void, Error>
  readonly callback: (
    redirectUrl: string,
    expectedState: string,
  ) => Effect.Effect<Effect.Effect<string, Error>, Error, Scope.Scope>
}

export class Host extends Context.Service<Host, HostInterface>()("@rika/extensions/mcp-oauth/Host") {}

export const hostTestLayer = (implementation: HostInterface) => Layer.succeed(Host, Host.of(implementation))

interface BrowserCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

const browserCommandImpl = (platform: NodeJS.Platform, url: string): BrowserCommand => ({
  command: platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open",
  args: platform === "win32" ? ["/c", "start", "", url] : [url],
})

export const browserCommand: {
  (url: string): (platform: NodeJS.Platform) => BrowserCommand
  (platform: NodeJS.Platform, url: string): BrowserCommand
} = Function.dual(2, browserCommandImpl)

export const hostLayer = Layer.effect(
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
                  Error.make({
                    server: "system-browser",
                    operation: "open-browser",
                    message: "Unable to open the system browser",
                  }),
                ),
              )
            const exitCode = yield* child.exitCode.pipe(
              Effect.mapError(() =>
                Error.make({
                  server: "system-browser",
                  operation: "open-browser",
                  message: "Unable to open the system browser",
                }),
              ),
            )
            if (exitCode !== 0)
              return yield* Error.make({
                server: "system-browser",
                operation: "open-browser",
                message: "Unable to open the system browser",
              })
          }),
        ),
      ),
      callback: Effect.fn("McpOAuthHost.callback")((redirectUrl, expectedState) =>
        Effect.gen(function* () {
          const target = yield* Effect.try({
            try: () => new URL(redirectUrl),
            catch: () =>
              Error.make({ server: redirectUrl, operation: "callback", message: "Unable to bind the OAuth callback" }),
          })
          const completed = yield* Deferred.make<string>()
          const server = yield* BunHttpServer.make({
            hostname: target.hostname,
            port: Number(target.port),
          }).pipe(
            Effect.catchCause(() =>
              Effect.fail(
                Error.make({
                  server: redirectUrl,
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

export const tokenStoreLayer = (
  filename: string,
): Layer.Layer<OAuth.TokenStore, never, FileSystem.FileSystem | Path.Path> =>
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
      const failure = (server: string, operation: string) =>
        OAuth.OAuthProviderError.make({ server, operation, message: `OAuth token ${operation} failed` })
      return OAuth.TokenStore.of({
        load: Effect.fn("McpOAuthTokenStore.load")((server) =>
          read().pipe(
            Effect.map((values) =>
              values[server] === undefined ? Option.none() : Option.some(Redacted.make(values[server])),
            ),
            Effect.mapError(() => failure(server, "load")),
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
            Effect.mapError(() => failure(server, "save")),
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
            Effect.mapError(() => failure(server, "remove")),
          ),
        ),
      })
    }),
  )

export interface Interface {
  readonly login: (server: string, url: string) => Effect.Effect<void, Error>
  readonly logout: (server: string, url: string) => Effect.Effect<void, Error>
  readonly status: (server: string, url: string) => Effect.Effect<"authenticated" | "unauthenticated", Error>
}

export class Service extends Context.Service<Service, Interface>()("@rika/extensions/mcp-oauth/Service") {}

const redirectUrl = "http://127.0.0.1:17839/oauth/callback"

export interface OAuthClient {
  readonly authorize: Effect.Effect<OAuth.Authorization, OAuth.OAuthProviderError>
  readonly callback: (url: string) => Effect.Effect<void, OAuthClientError>
  readonly clear: Effect.Effect<void, OAuth.OAuthProviderError>
}

export type OAuthClientError = OAuth.OAuthDeniedError | OAuth.OAuthExpiredError | OAuth.OAuthProviderError

const service = (
  oauth: (server: string, url: string) => Effect.Effect<OAuthClient>,
): Effect.Effect<Interface, never, Host | OAuth.TokenStore> =>
  Effect.gen(function* () {
    const host = yield* Host
    const store = yield* OAuth.TokenStore
    const map = (server: string, operation: string) =>
      Effect.mapError((cause: unknown) => {
        const detail =
          typeof cause === "object" && cause !== null && "_tag" in cause
            ? cause._tag === "OAuthExpiredError"
              ? "OAuth callback state is invalid or expired"
              : cause._tag === "OAuthDeniedError"
                ? "OAuth authorization was denied"
                : cause._tag === "OAuthProviderError" && "operation" in cause && typeof cause.operation === "string"
                  ? `OAuth ${cause.operation} failed`
                  : `OAuth ${operation} failed`
            : `OAuth ${operation} failed`
        return Error.make({ server, operation, message: detail })
      })
    return Service.of({
      login: Effect.fn("McpOAuth.login")((server, url) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* oauth(server, url).pipe(map(server, "login"))
            const authorization = yield* client.authorize.pipe(map(server, "login"))
            const callback = yield* host.callback(redirectUrl, authorization.state)
            yield* host.open(authorization.url)
            yield* client.callback(yield* callback).pipe(map(server, "login"))
          }),
        ),
      ),
      logout: Effect.fn("McpOAuth.logout")(function* (server, url) {
        const client = yield* oauth(server, url).pipe(map(server, "logout"))
        yield* client.clear.pipe(map(server, "logout"))
      }),
      status: Effect.fn("McpOAuth.status")((server, url) =>
        store.load(url).pipe(
          Effect.map((value) => (Option.isSome(value) ? ("authenticated" as const) : ("unauthenticated" as const))),
          map(server, "status"),
        ),
      ),
    })
  })

export const layerWithClient = (
  oauth: (server: string, url: string) => Effect.Effect<OAuthClient>,
): Layer.Layer<Service, never, Host | OAuth.TokenStore> => Layer.effect(Service, service(oauth))

export const layer: Layer.Layer<Service, never, Host | OAuth.TokenStore> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* OAuth.TokenStore
    const oauth = (_server: string, url: string) =>
      Effect.scoped(
        Layer.build(
          OAuth.layer({
            serverUrl: url,
            redirectUrl,
            clientMetadata: { redirect_uris: [redirectUrl], client_name: "Rika" },
          }),
        ),
      ).pipe(
        Effect.map((context) => {
          const client = Context.get(context, OAuth.OAuth)
          return {
            authorize: client.authorize(),
            callback: client.callback,
            clear: client.clear,
          }
        }),
        Effect.provideService(OAuth.TokenStore, store),
      )
    return yield* service(oauth)
  }),
)

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
