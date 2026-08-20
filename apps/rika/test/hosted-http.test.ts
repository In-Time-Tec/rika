import { Context, Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { generate, publicJwk, thumbprint } from "../src/hosted/hosted-dpop"
import { Http } from "../src/hosted/hosted-contract"
import { layer } from "../src/hosted/hosted-http"

const response = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") return ""
  return new TextDecoder().decode(request.body.body)
}

it.effect("uses per-install registration, Better Auth OAuth paths, DPoP, and connection placement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const client = HttpClient.make((request) => {
        requests.push(request)
        const path = new URL(request.url).pathname
        if (path === "/api/v1/auth/cli/registrations")
          return Effect.succeed(response(request, { client_id: "install-client" }))
        if (path === "/api/auth/device/code")
          return Effect.succeed(
            response(request, {
              device_code: "device-code",
              user_code: "ABCD",
              verification_uri: "https://hosted.example.test/device",
              expires_in: 600,
              interval: 2,
            }),
          )
        if (path === "/api/auth/oauth2/token" && bodyText(request).includes("device_code="))
          return Effect.succeed(response(request, { error: "authorization_pending" }, 400))
        if (path === "/api/auth/oauth2/token")
          return Effect.succeed(
            response(request, {
              access_token: "new-access",
              expires_in: 600,
              token_type: "DPoP",
            }),
          )
        if (path === "/api/v1/me/context")
          return Effect.succeed(
            response(request, {
              account: { id: "account-1", email: "dev@example.test" },
              organizations: [{ id: "org-1", slug: "engineering", name: "Engineering" }],
            }),
          )
        if (path === "/api/v1/auth/cli/devices")
          return Effect.succeed(response(request, { devices: [{ id: "device-1", current: true }] }))
        if (path.endsWith("/invitations"))
          return Effect.succeed(response(request, { id: "invite-1", email: "new@example.test", status: "pending" }))
        if (path === "/api/v1/connections")
          return Effect.succeed(
            response(request, { threadId: "thread-1", url: "https://hosted.example.test/threads/thread-1" }),
          )
        if (path === "/api/v1/threads/e2b_thread-1/operations")
          return Effect.succeed(response(request, { output: "done" }))
        return Effect.succeed(response(request, {}))
      })
      const context = yield* Layer.build(
        layer.pipe(Layer.provide(Layer.merge(BunCrypto.layer, Layer.succeed(HttpClient.HttpClient, client)))),
      )
      const http = Context.get(context, Http)
      const origin = "https://hosted.example.test"
      const privateJwk = yield* generate()
      const publicKey = publicJwk(privateJwk)
      const jkt = yield* thumbprint(publicKey)
      const accessToken = Redacted.make("access")
      const session = { accessToken, privateJwk }
      const threadId = "e2b_thread-1"
      expect((yield* http.register(origin, "device-1", publicKey, jkt)).clientId).toBe("install-client")
      expect((yield* http.startDeviceAuthorization(origin, "install-client", privateJwk)).deviceCode).toBe(
        "device-code",
      )
      expect(
        (yield* http.pollDeviceAuthorization(origin, "install-client", Redacted.make("device-code"), privateJwk))._tag,
      ).toBe("Pending")
      expect(yield* http.refresh(origin, "install-client", Redacted.make("refresh"), privateJwk)).toEqual({
        accessToken: "new-access",
        refreshToken: "refresh",
        expiresIn: 600,
      })
      expect((yield* http.context(origin, session)).account.email).toBe("dev@example.test")
      expect((yield* http.devices(origin, session))[0]?.id).toBe("device-1")
      expect((yield* http.invite(origin, "org-1", "new@example.test", session)).id).toBe("invite-1")
      yield* http.revokeDevice(origin, "device-1", session)
      yield* http.revokeAllDevices(origin, session)
      expect((yield* http.createRemoteConnection(origin, "org-1", "project-1", session)).threadId).toBe("thread-1")
      expect(
        (yield* http.runThread(origin, "org-1", threadId, { prompt: ["hello"], mode: "low" }, "operation-1", session))
          .output,
      ).toBe("done")
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/v1/auth/cli/registrations",
        "/api/auth/device/code",
        "/api/auth/oauth2/token",
        "/api/auth/oauth2/token",
        "/api/v1/me/context",
        "/api/v1/auth/cli/devices",
        "/api/v1/organizations/org-1/invitations",
        "/api/v1/auth/cli/devices/device-1/revoke",
        "/api/v1/auth/cli/devices/revoke-all",
        "/api/v1/connections",
        "/api/v1/threads/e2b_thread-1/operations",
      ])
      for (const request of requests.slice(1)) expect(request.headers.dpop).toEqual(expect.any(String))
      expect(requests[4]?.headers.authorization).toBe("DPoP access")
      expect(bodyText(requests[0]!)).toContain('"reference_id":"cli-device:device-1"')
      expect(bodyText(requests[8]!)).toBe("")
      expect(bodyText(requests[9]!)).toContain('"placement":"e2b"')
      expect(requests[10]?.headers["idempotency-key"]).toBe("operation-1")
      expect(bodyText(requests[10]!)).toBe('{"kind":"run","organization_id":"org-1","prompt":["hello"],"mode":"low"}')
    }),
  ),
)
