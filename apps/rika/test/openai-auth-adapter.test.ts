import * as BunServices from "@effect/platform-bun/BunServices"
import { OpenAiAuth } from "@rika/app"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { hostLayer, httpLayer } from "../src/openai-auth-adapter"

const response = (request: HttpClientRequest.HttpClientRequest, status: number, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(Schema.encodeSync(Schema.UnknownFromJsonString)(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const clientLayer = (
  execute: (request: HttpClientRequest.HttpClientRequest) => HttpClientResponse.HttpClientResponse,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(execute(request))),
  )

const build = (execute: (request: HttpClientRequest.HttpClientRequest) => HttpClientResponse.HttpClientResponse) =>
  Layer.build(Layer.fresh(httpLayer).pipe(Layer.provide(clientLayer(execute)))).pipe(
    Effect.map((context) => Context.get(context, OpenAiAuth.Http)),
  )

const requestText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const provideLayer = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, provided: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(Layer.build(provided).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

describe("OpenAI authentication HTTP adapter", () => {
  it.effect("accepts only the exact loopback callback method, path, and state", () =>
    Effect.gen(function* () {
      const host = yield* OpenAiAuth.Host
      const state = Redacted.make("expected-state")
      const pending = yield* Effect.forkScoped(host.authorize(new URL("https://auth.openai.test/authorize"), state))
      yield* Effect.yieldNow
      const client = yield* HttpClient.HttpClient
      expect(
        (yield* client.execute(HttpClientRequest.get("http://127.0.0.1:1455/wrong?state=expected-state"))).status,
      ).toBe(404)
      expect(
        (yield* client.execute(HttpClientRequest.post("http://127.0.0.1:1455/auth/callback?state=expected-state")))
          .status,
      ).toBe(404)
      expect(
        (yield* client.execute(HttpClientRequest.get("http://127.0.0.1:1455/auth/callback?state=wrong&code=forged")))
          .status,
      ).toBe(400)
      const accepted = yield* client.execute(
        HttpClientRequest.get("http://127.0.0.1:1455/auth/callback?state=expected-state&code=authorization-secret"),
      )
      expect(accepted.status).toBe(200)
      const result = yield* Fiber.join(pending)
      expect(Redacted.value(result.code)).toBe("authorization-secret")
      expect(Redacted.value(result.state)).toBe("expected-state")
    }).pipe((effect) =>
      provideLayer(
        effect,
        Layer.mergeAll(hostLayer, TestConsole.layer, FetchHttpClient.layer).pipe(Layer.provide(BunServices.layer)),
      ),
    ),
  )

  it.effect("uses the exact form-encoded authorization exchange without exposing values in errors", () =>
    Effect.gen(function* () {
      let captured: HttpClientRequest.HttpClientRequest | undefined
      const http = yield* build((request) => {
        captured = request
        return response(request, 200, {
          access_token: "access-secret",
          id_token: "identity-secret",
          refresh_token: "refresh-secret",
        })
      })
      yield* http.exchange({
        code: Redacted.make("authorization-secret"),
        verifier: Redacted.make("verifier-secret"),
        redirectUri: OpenAiAuth.redirectUri,
      })
      expect(captured?.url).toBe("https://auth.openai.com/oauth/token")
      expect(captured?.headers["content-type"]).toContain("application/x-www-form-urlencoded")
      expect(new URLSearchParams(requestText(captured!)).get("grant_type")).toBe("authorization_code")
      expect(new URLSearchParams(requestText(captured!)).get("code")).toBe("authorization-secret")
      expect(new URLSearchParams(requestText(captured!)).get("code_verifier")).toBe("verifier-secret")
    }),
  )

  it.effect("treats only device 403 and 404 responses as pending", () =>
    Effect.gen(function* () {
      for (const status of [403, 404]) {
        const http = yield* build((request) => response(request, status, {}))
        const pending = yield* Effect.exit(http.devicePoll(Redacted.make("device-secret"), "ABCD"))
        expect(Exit.isSuccess(pending)).toBe(true)
      }
      const rejected = yield* build((request) => response(request, 429, { error: "slow_down" }))
      const error = yield* Effect.flip(rejected.devicePoll(Redacted.make("device-secret"), "ABCD"))
      expect(error.kind).toBe("network")
      expect(encodeJson(error)).not.toContain("device-secret")
      expect(encodeJson(error)).not.toContain("slow_down")
    }),
  )

  it.effect("classifies permanent refresh rotation failures without returning provider bodies", () =>
    Effect.gen(function* () {
      let captured: HttpClientRequest.HttpClientRequest | undefined
      const http = yield* build((request) => {
        captured = request
        return response(request, 400, { error: { code: "refresh_token_reused", message: "provider-secret" } })
      })
      const error = yield* Effect.flip(http.refresh(Redacted.make("refresh-secret")))
      expect(error.kind).toBe("login-required")
      expect(captured?.headers["content-type"]).toContain("application/json")
      expect(requestText(captured!)).toContain('"grant_type":"refresh_token"')
      expect(encodeJson(error)).not.toContain("refresh-secret")
      expect(encodeJson(error)).not.toContain("provider-secret")
    }),
  )
})
