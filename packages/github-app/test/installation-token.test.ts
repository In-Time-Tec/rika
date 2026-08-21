import * as AppJwt from "../src/app-jwt"
import * as InstallationToken from "../src/installation-token"
import { repository } from "./github-fixtures"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { provide } from "./test-layer"

const RequestBody = Schema.fromJsonString(
  Schema.Struct({
    repository_ids: Schema.Array(Schema.Int),
    permissions: Schema.Record(Schema.String, Schema.String),
  }),
)

const requestBody = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") return undefined
  return Schema.decodeUnknownSync(RequestBody)(new TextDecoder().decode(request.body.body))
}

const response = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 201) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )

const resolvedLayer = (clientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  InstallationToken.installationTokenLayer({ baseUrl: "https://github.test" }).pipe(
    Layer.provide(Layer.merge(clientLayer, AppJwt.appJwtTestLayer(Effect.succeed(Redacted.make("app-jwt-secret"))))),
  )

describe("GitHub installation repository tokens", () => {
  it.effect("mints exact repository and permission scopes and caches only until expiry minus five minutes", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const expiries = ["2023-11-14T23:13:20.000Z", "2023-11-14T23:13:20.000Z", "2023-11-15T00:08:20.000Z"]
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request)
        const body = requestBody(request)!
        const repositories = body.repository_ids.map(repository)
        return Effect.succeed(
          response(request, {
            token: `installation-token-${requests.length}`,
            expires_at: expiries[requests.length - 1],
            permissions: { ...body.permissions, metadata: "read" },
            repositories,
          }),
        )
      }),
    )
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000)
      const tokens = yield* InstallationToken.InstallationToken
      const first = yield* tokens.mint({
        installationId: 42,
        repositoryIds: [2, 1, 2],
        permissions: { contents: "read" },
      })
      const cached = yield* tokens.mint({
        installationId: 42,
        repositoryIds: [1, 2],
        permissions: { contents: "read" },
      })
      expect(first.repositoryIds).toEqual([1, 2])
      expect(Redacted.value(first.token)).toBe("installation-token-1")
      expect(cached.token).toBe(first.token)
      expect(requests).toHaveLength(1)
      expect(requestBody(requests[0]!)!).toEqual({
        repository_ids: [1, 2],
        permissions: { contents: "read" },
      })
      const broader = yield* tokens.mint({
        installationId: 42,
        repositoryIds: [1, 2],
        permissions: { contents: "write" },
      })
      expect(Redacted.value(broader.token)).toBe("installation-token-2")
      expect(requests).toHaveLength(2)
      yield* TestClock.adjust("54 minutes")
      expect(
        Redacted.value(
          (yield* tokens.mint({
            installationId: 42,
            repositoryIds: [1, 2],
            permissions: { contents: "read" },
          })).token,
        ),
      ).toBe("installation-token-1")
      yield* TestClock.adjust("1 minute")
      expect(
        Redacted.value(
          (yield* tokens.mint({
            installationId: 42,
            repositoryIds: [1, 2],
            permissions: { contents: "read" },
          })).token,
        ),
      ).toBe("installation-token-3")
      expect(requests).toHaveLength(3)
    }).pipe(provide(resolvedLayer(clientLayer)))
  })

  it.effect("rejects empty, mismatched, and over-broad token scopes", () => {
    let mode: "repositories" | "permissions" = "repositories"
    let calls = 0
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        calls += 1
        return Effect.succeed(
          response(request, {
            token: "scope-secret",
            expires_at: "2030-01-01T00:00:00Z",
            permissions: mode === "repositories" ? { contents: "read" } : { contents: "write", issues: "write" },
            repositories: mode === "repositories" ? [repository(1), repository(2)] : [repository(1)],
          }),
        )
      }),
    )
    return Effect.gen(function* () {
      const tokens = yield* InstallationToken.InstallationToken
      const empty = yield* Effect.flip(tokens.mint({ installationId: 42, repositoryIds: [1], permissions: {} }))
      expect(empty.reason).toBe("input")
      expect(calls).toBe(0)
      const repositories = yield* Effect.flip(
        tokens.mint({ installationId: 42, repositoryIds: [1], permissions: { contents: "read" } }),
      )
      expect(repositories.reason).toBe("scope")
      mode = "permissions"
      const permissions = yield* Effect.flip(
        tokens.mint({ installationId: 42, repositoryIds: [1], permissions: { contents: "write" } }),
      )
      expect(permissions.reason).toBe("scope")
    }).pipe(provide(resolvedLayer(clientLayer)))
  })

  it.effect("rejects credentials lasting over one hour and removes revoked credentials from the cache", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    let expiry = "2023-11-14T23:13:20.001Z"
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request)
        if (request.method === "DELETE")
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
        const body = requestBody(request)!
        return Effect.succeed(
          response(request, {
            token: `installation-token-${requests.length}`,
            expires_at: expiry,
            permissions: { ...body.permissions, metadata: "read" },
            repositories: body.repository_ids.map(repository),
          }),
        )
      }),
    )
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000)
      const tokens = yield* InstallationToken.InstallationToken
      const request = { installationId: 42, repositoryIds: [1], permissions: { contents: "read" as const } }
      expect((yield* Effect.flip(tokens.mint(request))).reason).toBe("scope")
      expiry = "2023-11-14T23:13:20.000Z"
      const first = yield* tokens.mint(request)
      expect(yield* tokens.mint(request)).toBe(first)
      yield* tokens.revoke(first.token)
      const next = yield* tokens.mint(request)
      expect(next.token).not.toBe(first.token)
      expect(requests.map((entry) => entry.method)).toEqual(["POST", "POST", "DELETE", "POST"])
    }).pipe(provide(resolvedLayer(clientLayer)))
  })

  it.effect("keeps authorization and response secrets out of typed failures and logs", () => {
    const secrets = ["app-jwt-secret", "response-token-secret"]
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(response(request, { token: secrets[1], message: secrets[1] }, 500))),
    )
    return Effect.gen(function* () {
      const tokens = yield* InstallationToken.InstallationToken
      const error = yield* Effect.flip(
        tokens.mint({ installationId: 42, repositoryIds: [1], permissions: { metadata: "read" } }),
      )
      yield* Effect.logError(error)
      const output = [...(yield* TestConsole.errorLines), String(error)].join("\n")
      for (const secret of secrets) expect(output).not.toContain(secret)
      expect(output).toContain("GitHub rejected the repository token request")
    }).pipe(provide(Layer.merge(resolvedLayer(clientLayer), TestConsole.layer)))
  })
})
