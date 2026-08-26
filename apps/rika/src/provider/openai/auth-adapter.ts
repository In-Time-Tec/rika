import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as OpenAiAuthHttp from "@rika/product/openai-auth-http"
import * as OpenAiAuthService from "@rika/product/openai-auth-service"
import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
namespace OpenAiAuth {
  export import AuthError = OpenAiAuthContract.AuthError
  export import Host = OpenAiAuthService.Host
  export import Http = OpenAiAuthService.Http
  export import Presenter = OpenAiAuthService.Presenter
  export const layer = OpenAiAuthService.layer
  export const issuer = OpenAiAuthService.configuration.issuer
  export const clientId = OpenAiAuthService.configuration.clientId
  export const redirectUri = OpenAiAuthService.configuration.redirectUri
  export import TokenResponse = OpenAiAuthContract.TokenResponse
  export import DeviceStartResponse = OpenAiAuthContract.DeviceStartResponse
  export import DevicePollResponse = OpenAiAuthContract.DevicePollResponse
  export type AuthorizationResult = {
    readonly code: Redacted.Redacted<string>
    readonly state: Redacted.Redacted<string>
  }
}
import { Console, Deferred, Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const browserCommand = (url: string) => {
  let command: string
  if (process.platform === "darwin") command = "open"
  else if (process.platform === "win32") command = "cmd"
  else command = "xdg-open"
  return {
    command,
    args: process.platform === "win32" ? ["/c", "start", "", url] : [url],
  }
}

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

export const presenterLayer = Layer.succeed(
  OpenAiAuth.Presenter,
  OpenAiAuth.Presenter.of({
    device: ({ verificationUrl, userCode, warning }) =>
      Console.log(`Open ${verificationUrl}\nEnter code: ${userCode}\n${warning}`).pipe(
        Effect.mapError(() => authFailure("host", "Could not display device authorization instructions")),
      ),
  }),
)

export const httpLayer = OpenAiAuthHttp.layer

export const layer = OpenAiAuth.layer().pipe(
  Layer.provide(Layer.mergeAll(hostLayer, OpenAiAuthHttp.layer, presenterLayer)),
)
