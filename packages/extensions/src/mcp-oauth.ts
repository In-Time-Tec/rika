import { OAuth } from "@batonfx/mcp"
import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"

export class Error extends Schema.TaggedErrorClass<Error>()("@rika/extensions/McpOAuthError", {
  server: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface HostInterface {
  readonly open: (url: string) => Effect.Effect<void, Error>
  readonly callback: (redirectUrl: string) => Effect.Effect<string, Error>
}

export class Host extends Context.Service<Host, HostInterface>()("@rika/extensions/mcp-oauth/Host") {}

export const hostTestLayer = (implementation: HostInterface) => Layer.succeed(Host, Host.of(implementation))

export const hostLayer = Layer.succeed(
  Host,
  Host.of({
    open: Effect.fn("McpOAuthHost.open")((url) =>
      Effect.gen(function* () {
        const exitCode = yield* Effect.tryPromise({
          try: () => {
            const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
            const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
            const child = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" })
            return child.exited
          },
          catch: (cause) => Error.make({ server: url, operation: "open-browser", message: String(cause) }),
        })
        if (exitCode !== 0) {
          return yield* Error.make({ server: url, operation: "open-browser", message: "browser command failed" })
        }
      }),
    ),
    callback: Effect.fn("McpOAuthHost.callback")((redirectUrl) =>
      Effect.callback<string, Error>((resume) => {
        let server: ReturnType<typeof Bun.serve> | undefined
        try {
          const target = new URL(redirectUrl)
          const active = Bun.serve({
            hostname: target.hostname,
            port: Number(target.port),
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname !== target.pathname) return new Response("Not found", { status: 404 })
              resume(Effect.succeed(url.toString()))
              queueMicrotask(() => active.stop())
              return new Response("Authentication complete. You may close this window.")
            },
          })
          server = active
        } catch (cause) {
          resume(Effect.fail(Error.make({ server: redirectUrl, operation: "callback", message: String(cause) })))
        }
        return Effect.sync(() => server?.stop())
      }),
    ),
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
          Effect.flatMap((exists) => (exists ? fileSystem.readFileString(filename) : Effect.succeed("{}"))),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))),
          ),
        ),
      )
      const failure = (server: string, operation: string, cause: unknown) =>
        OAuth.OAuthProviderError.make({ server, operation, message: String(cause) })
      return OAuth.TokenStore.of({
        load: Effect.fn("McpOAuthTokenStore.load")((server) =>
          read().pipe(
            Effect.map((values) =>
              values[server] === undefined ? Option.none() : Option.some(Redacted.make(values[server])),
            ),
            Effect.mapError((cause) => failure(server, "load", cause)),
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
                  ),
                ),
                Effect.andThen(fileSystem.chmod(filename, 0o600)),
              ),
            ),
            Effect.mapError((cause) => failure(server, "save", cause)),
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
                    ),
                  ),
                  Effect.andThen(fileSystem.chmod(filename, 0o600)),
                )
            }),
            Effect.mapError((cause) => failure(server, "remove", cause)),
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

export const layer: Layer.Layer<Service, never, Host | OAuth.TokenStore> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const host = yield* Host
    const store = yield* OAuth.TokenStore
    const oauth = (server: string, url: string) =>
      Effect.scoped(
        Layer.build(
          OAuth.layer({
            serverUrl: url,
            redirectUrl,
            clientMetadata: { redirect_uris: [redirectUrl], client_name: "Rika" },
          }),
        ),
      ).pipe(
        Effect.map((context) => Context.get(context, OAuth.OAuth)),
        Effect.provideService(OAuth.TokenStore, store),
      )
    const map = (server: string, operation: string) =>
      Effect.mapError((cause: unknown) =>
        Error.make({ server, operation, message: cause instanceof globalThis.Error ? cause.message : String(cause) }),
      )
    return Service.of({
      login: Effect.fn("McpOAuth.login")(function* (server, url) {
        const client = yield* oauth(server, url).pipe(map(server, "login"))
        const authorization = yield* client.authorize().pipe(map(server, "login"))
        yield* host.open(authorization.url)
        const callback = yield* host.callback(redirectUrl)
        yield* client.callback(callback).pipe(map(server, "login"))
      }),
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
  }),
)

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
