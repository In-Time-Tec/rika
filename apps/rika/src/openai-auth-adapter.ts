import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { OpenAiAuth } from "@rika/app"
import { Console, Deferred, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const browserCommand = (url: string) => ({
  command: process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open",
  args: process.platform === "win32" ? ["/c", "start", "", url] : [url],
})

const authFailure = (kind: OpenAiAuth.AuthError["kind"], message: string) =>
  OpenAiAuth.AuthError.make({ kind, message })

export const hostLayer = Layer.effect(
  OpenAiAuth.Host,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return OpenAiAuth.Host.of({
      authorize: Effect.fn("OpenAiAuthHost.authorize")((authorizationUrl, expectedState) =>
        Effect.scoped(
          Effect.gen(function* () {
            const callback = new URL(OpenAiAuth.redirectUri)
            const completed = yield* Deferred.make<OpenAiAuth.AuthorizationResult, OpenAiAuth.AuthError>()
            const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: Number(callback.port) }).pipe(
              Effect.mapError(() => authFailure("host", "Could not start the loopback authorization callback")),
            )
            const app = Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest
              const url = new URL(request.url, callback)
              if (request.method !== "GET" || url.pathname !== callback.pathname) {
                return HttpServerResponse.text("Not found", { status: 404 })
              }
              const state = url.searchParams.get("state")
              if (state === null || state !== Redacted.value(expectedState)) {
                return HttpServerResponse.text("Authorization state did not match.", { status: 400 })
              }
              if (url.searchParams.has("error")) {
                yield* Deferred.fail(completed, authFailure("cancelled", "OpenAI account authorization was cancelled"))
                return HttpServerResponse.text("Authorization was cancelled. You may close this window.", {
                  status: 400,
                })
              }
              const code = url.searchParams.get("code")
              if (code === null || code.length === 0) {
                yield* Deferred.fail(completed, authFailure("protocol", "Authorization code was missing"))
                return HttpServerResponse.text("Authorization failed. You may close this window.", { status: 400 })
              }
              yield* Deferred.succeed(completed, {
                code: Redacted.make(code),
                state: Redacted.make(state),
              })
              return HttpServerResponse.text("Authentication complete. You may close this window.")
            })
            yield* server.serve(app)
            yield* Console.log(`Open this URL to continue OpenAI account login:\n${authorizationUrl.toString()}`)
            const { command, args } = browserCommand(authorizationUrl.toString())
            yield* Effect.forkScoped(
              spawner.spawn(ChildProcess.make(command, args, { stdout: "ignore", stderr: "ignore" })).pipe(
                Effect.flatMap((child) => child.exitCode),
                Effect.ignore,
              ),
            )
            const result = yield* Deferred.await(completed).pipe(Effect.timeoutOption("10 minutes"))
            if (Option.isNone(result)) return yield* authFailure("timeout", "OpenAI account authorization timed out")
            return result.value
          }),
        ),
      ),
    })
  }),
)

const PermanentRefreshError = Schema.Struct({
  error: Schema.optionalKey(Schema.Union([Schema.String, Schema.Struct({ code: Schema.optionalKey(Schema.String) })])),
  code: Schema.optionalKey(Schema.String),
})

const decode = <S extends Schema.Constraint>(response: HttpClientResponse.HttpClientResponse, schema: S) =>
  HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(() => authFailure("protocol", "OpenAI authorization returned an invalid response")),
  )

export const httpLayer = Layer.effect(
  OpenAiAuth.Http,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(authFailure("timeout", "OpenAI authorization request timed out")),
        ),
      )
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client
        .execute(request)
        .pipe(
          Effect.mapError((error) =>
            Schema.is(OpenAiAuth.AuthError)(error)
              ? error
              : authFailure("network", "OpenAI authorization request failed"),
          ),
        )
    const tokenRequest = (request: HttpClientRequest.HttpClientRequest) =>
      bounded(
        execute(request).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? decode(response, OpenAiAuth.TokenResponse)
              : Effect.fail(authFailure("protocol", "OpenAI token exchange failed")),
          ),
        ),
      )
    return OpenAiAuth.Http.of({
      exchange: ({ code, verifier, redirectUri }) =>
        tokenRequest(
          HttpClientRequest.post(`${OpenAiAuth.issuer}/oauth/token`).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "authorization_code",
              code: Redacted.value(code),
              redirect_uri: redirectUri,
              client_id: OpenAiAuth.clientId,
              code_verifier: Redacted.value(verifier),
            }),
          ),
        ),
      refresh: (refreshToken) =>
        bounded(
          execute(
            HttpClientRequest.post(`${OpenAiAuth.issuer}/oauth/token`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                client_id: OpenAiAuth.clientId,
                grant_type: "refresh_token",
                refresh_token: Redacted.value(refreshToken),
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => {
              if (response.status >= 200 && response.status < 300) return decode(response, OpenAiAuth.TokenResponse)
              if (response.status === 401) {
                return Effect.fail(
                  authFailure("login-required", "OpenAI account refresh was rejected; login is required"),
                )
              }
              return decode(response, PermanentRefreshError).pipe(
                Effect.flatMap((body) => {
                  const code = typeof body.error === "string" ? body.error : (body.error?.code ?? body.code)
                  return Effect.fail(
                    code === "refresh_token_expired" ||
                      code === "refresh_token_reused" ||
                      code === "refresh_token_invalidated"
                      ? authFailure(
                          "login-required",
                          "OpenAI account refresh can no longer be recovered locally; login is required",
                        )
                      : authFailure("network", "OpenAI account refresh failed"),
                  )
                }),
                Effect.catch((error) =>
                  Schema.is(OpenAiAuth.AuthError)(error) && error.kind === "login-required"
                    ? Effect.fail(error)
                    : Effect.fail(authFailure("network", "OpenAI account refresh failed")),
                ),
              )
            }),
          ),
        ),
      deviceStart: bounded(
        execute(
          HttpClientRequest.post(`${OpenAiAuth.issuer}/api/accounts/deviceauth/usercode`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ client_id: OpenAiAuth.clientId }),
          ),
        ).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? decode(response, OpenAiAuth.DeviceStartResponse)
              : Effect.fail(
                  authFailure(
                    response.status === 404 ? "protocol" : "network",
                    response.status === 404
                      ? "OpenAI device-code login is not available"
                      : "OpenAI device-code login could not be started",
                  ),
                ),
          ),
        ),
      ),
      devicePoll: (deviceAuthId, userCode) =>
        bounded(
          execute(
            HttpClientRequest.post(`${OpenAiAuth.issuer}/api/accounts/deviceauth/token`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                device_auth_id: Redacted.value(deviceAuthId),
                user_code: userCode,
              }),
            ),
          ).pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? decode(response, OpenAiAuth.DevicePollResponse).pipe(Effect.map(Option.some))
                : response.status === 403 || response.status === 404
                  ? Effect.succeed(Option.none())
                  : Effect.fail(authFailure("network", "OpenAI device authorization failed")),
            ),
          ),
        ),
    })
  }),
)

export const presenterLayer = Layer.succeed(
  OpenAiAuth.Presenter,
  OpenAiAuth.Presenter.of({
    device: ({ verificationUrl, userCode, warning }) =>
      Console.log(`Open ${verificationUrl}\nEnter code: ${userCode}\n${warning}`).pipe(
        Effect.mapError(() => authFailure("host", "Could not display device authorization instructions")),
      ),
  }),
)

export const layer = OpenAiAuth.layer().pipe(Layer.provide(Layer.mergeAll(hostLayer, httpLayer, presenterLayer)))
