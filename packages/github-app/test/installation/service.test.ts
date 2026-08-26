import * as AppJwt from "../../src/auth/jwt"
import * as GitHubInstallation from "../../src/installation/service"
import { installation, repository } from "../support/github.fixture"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { provide } from "../support/layer"

const response = (
  request: HttpClientRequest.HttpClientRequest,
  body: Schema.Json | InstallationPayload,
  status = 200,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )

interface InstallationPayload extends Omit<typeof installation, "app_id" | "suspended_at"> {
  readonly app_id: number
  readonly suspended_at: string | null
}

describe("GitHub installation service", () => {
  it.effect("verifies app ownership and reconciles every repository page with metadata-only inventory access", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const repositories = Array.from({ length: 101 }, (_, index) => repository(index + 1))
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request)
        if (request.url.endsWith("/app/installations/42")) return Effect.succeed(response(request, installation))
        if (request.url.endsWith("/access_tokens")) {
          return Effect.succeed(response(request, { token: "inventory-token", expires_at: "2030-01-01T00:00:00Z" }))
        }
        const page = request.url.endsWith("page=1") ? repositories.slice(0, 100) : repositories.slice(100)
        return Effect.succeed(response(request, { total_count: repositories.length, repositories: page }))
      }),
    )
    const layer = GitHubInstallation.installationLayer({ appId: 123, baseUrl: "https://github.test" }).pipe(
      Layer.provide(Layer.merge(clientLayer, AppJwt.appJwtTestLayer(Effect.succeed(Redacted.make("app-jwt"))))),
    )
    return Effect.gen(function* () {
      yield* TestClock.setTime(123_000)
      const service = yield* GitHubInstallation.Installation
      const snapshot = yield* service.reconcileInstallation(42)
      expect(snapshot.installation.account.login).toBe("octo-org")
      expect(snapshot.repositories).toHaveLength(101)
      expect(snapshot.reconciledAtMillis).toBe(123_000)
      expect(requests.map((request) => request.url)).toEqual([
        "https://github.test/app/installations/42",
        "https://github.test/app/installations/42/access_tokens",
        "https://github.test/installation/repositories?per_page=100&page=1",
        "https://github.test/installation/repositories?per_page=100&page=2",
      ])
      expect(requests[0]?.headers.authorization).toBe("Bearer app-jwt")
      expect(requests[2]?.headers.authorization).toBe("Bearer inventory-token")
      expect(requests[1]?.body._tag).toBe("Uint8Array")
      if (requests[1]?.body._tag !== "Uint8Array") throw new Error("Expected inventory token JSON body")
      expect(new TextDecoder().decode(requests[1].body.body)).toBe('{"permissions":{"metadata":"read"}}')
    }).pipe(provide(layer))
  })

  it.effect("rejects installations owned by another app or suspended by GitHub", () => {
    let payload: InstallationPayload = { ...installation, app_id: 999 }
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(response(request, payload))),
    )
    const layer = GitHubInstallation.installationLayer({ appId: 123, baseUrl: "https://github.test" }).pipe(
      Layer.provide(Layer.merge(clientLayer, AppJwt.appJwtTestLayer(Effect.succeed(Redacted.make("app-jwt"))))),
    )
    return Effect.gen(function* () {
      const service = yield* GitHubInstallation.Installation
      expect((yield* Effect.flip(service.verifyInstallation(42))).reason).toBe("app_mismatch")
      payload = { ...installation, suspended_at: "2026-08-19T12:00:00Z" }
      expect((yield* Effect.flip(service.verifyInstallation(42))).reason).toBe("suspended")
    }).pipe(provide(layer))
  })
})
