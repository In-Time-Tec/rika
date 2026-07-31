import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { OAuth } from "@batonfx/mcp"
import { Context, Deferred, Effect, FileSystem, Function, Layer, Option, Path, Redacted, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class McpOAuthHostError extends Schema.TaggedErrorClass<McpOAuthHostError>()(
  "@rika/extensions/McpOAuthHostError",
  {
    server: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface HostInterface {
  readonly open: (url: string) => Effect.Effect<void, McpOAuthHostError>
  readonly callback: (
    redirectUrl: string,
    expectedState: string,
  ) => Effect.Effect<Effect.Effect<string, McpOAuthHostError>, McpOAuthHostError, Scope.Scope>
}

export class Host extends Context.Service<Host, HostInterface>()("@rika/extensions/mcp-oauth-store/Host") {}

export const hostTestLayer = (implementation: HostInterface) => Layer.succeed(Host, Host.of(implementation))

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
      callback: Effect.fn("McpOAuthHost.callback")((redirectUrl, expectedState) =>
        Effect.gen(function* () {
          const target = yield* Effect.try({
            try: () => new URL(redirectUrl),
            catch: () =>
              McpOAuthHostError.make({
                server: redirectUrl,
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

const tokenStoreFailure = (server: string, operation: string) =>
  OAuth.OAuthProviderError.make({ server, operation, message: `OAuth token ${operation} failed` })

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
