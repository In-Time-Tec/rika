import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { generate, publicJwk, thumbprint } from "../../src/hosted/dpop"
import { Http } from "../../src/hosted/contract"
import { layer } from "../../src/hosted/http"
import { WorkspaceId } from "@rika/product/hosted-model"

const response = (
  request: HttpClientRequest.HttpClientRequest,
  body: Schema.Json,
  status = 200,
  headers: Record<string, string> = {},
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }),
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") return ""
  return new TextDecoder().decode(request.body.body)
}

const hostedResponse = (request: HttpClientRequest.HttpClientRequest, path: string) => {
  if (path === "/api/v1/projects")
    return response(request, {
      id: "project-2",
      ownerId: "owner-1",
      owner: { kind: "organization", organizationId: "org-1" },
      slug: "remote",
      name: "Remote",
    })
  if (path === "/api/v1/environment/DEPLOY_TOKEN")
    return response(request, {
      id: "environment-1",
      name: "DEPLOY_TOKEN",
      scope: "project",
      classification: "secret",
      phases: ["runtime"],
      revision: "2",
      state: request.method === "DELETE" ? "revoked" : "active",
    })
  if (path.endsWith("/repository-publications"))
    return response(request, {
      publicationId: "publication-1",
      state: "completed",
      branch: "rika/thread-1",
      ref: "refs/heads/rika/thread-1",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      targetBranch: "main",
      targetCommitSha: "0123456789abcdef0123456789abcdef01234567",
      targetProtected: true,
      pushResult: {},
      pullRequestResult: {},
    })
  return undefined
}

it.effect("uses Better Auth DPoP and the canonical hosted Thread and runner endpoints", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const client = HttpClient.make((request) => {
        requests.push(request)
        const path = new URL(request.url).pathname
        const routed = hostedResponse(request, path)
        if (routed !== undefined) return Effect.succeed(routed)
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
              account: { id: "account-1", email: "dev@example.test", name: "Dev" },
              organizations: [{ id: "org-1", slug: "engineering", name: "Engineering", logo: null }],
              projects: [
                {
                  id: "project-1",
                  ownerId: "owner-1",
                  owner: { kind: "organization", organizationId: "org-1" },
                  slug: "api",
                  name: "API",
                },
              ],
            }),
          )
        if (path === "/api/v1/auth/cli/devices")
          return Effect.succeed(response(request, { devices: [{ id: "device-1", current: true }] }))
        if (path.endsWith("/invitations"))
          return Effect.succeed(response(request, { id: "invite-1", email: "new@example.test", status: "pending" }))
        if (path === "/api/v1/thread-sessions")
          return Effect.succeed(
            response(request, {
              ticket: "ticket-1",
              expiresAt: "2026-08-21T06:00:00.000Z",
              websocketUrl: "wss://hosted.example.test/api/v1/threads/socket",
              protocol: "rika.thread.v1",
            }),
          )
        if (path === "/api/v1/workspace-seeds")
          return Effect.succeed(
            response(
              request,
              {
                id: "seed-1",
                contentDigest: `sha256:${"d".repeat(64)}`,
                sizeBytes: 3,
                expiresAt: "2026-08-21T06:10:00.000Z",
              },
              201,
            ),
          )
        if (path.endsWith("/admissions"))
          return Effect.succeed(response(request, { _tag: "Waiting", reason: "no-work" }))
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
      expect(yield* http.context(origin, session)).toEqual({
        account: { id: "account-1", email: "dev@example.test", name: "Dev" },
        organizations: [{ id: "org-1", slug: "engineering", name: "Engineering", logo: null }],
        projects: [
          {
            id: "project-1",
            ownerId: "owner-1",
            owner: { kind: "organization", organizationId: "org-1" },
            slug: "api",
            name: "API",
          },
        ],
      })
      expect((yield* http.devices(origin, session))[0]?.id).toBe("device-1")
      expect((yield* http.invite(origin, "org-1", "new@example.test", session)).id).toBe("invite-1")
      yield* http.revokeDevice(origin, "device-1", session)
      yield* http.revokeAllDevices(origin, session)
      expect((yield* http.issueThreadTicket(origin, session)).ticket).toBe("ticket-1")
      expect(
        yield* http.uploadWorkspaceSeed(
          origin,
          { bytes: Uint8Array.from([1, 2, 3]), contentDigest: `sha256:${"d".repeat(64)}`, sizeBytes: 3 },
          { owner: "In-Time-Tec", name: "rika" },
          session,
        ),
      ).toMatchObject({ id: "seed-1", sizeBytes: 3 })
      yield* http.registerRunner(
        origin,
        "checkout-1",
        {
          workspaceIdentity: WorkspaceId.make("workspace-1"),
          repository: { identity: "repository-1" },
          kernel: { runtime: "bun", runtimeVersion: "1.3.14", trustMode: "trusted-local" },
          capabilities: { cells: true, checkpoints: false, pty: false },
        },
        session,
      )
      yield* http.setRemoteThreadCreation(origin, "checkout-1", "allowed", session)
      expect(
        (yield* http.pollRunner(origin, "checkout-1", "10000000-0000-4000-8000-000000000001", [], session))._tag,
      ).toBe("Waiting")
      expect(
        (yield* http.createProject(origin, { kind: "organization", organizationId: "org-1" }, "Remote", session)).id,
      ).toBe("project-2")
      expect(
        (yield* http.putEnvironment(
          origin,
          { kind: "organization", organizationId: "org-1" },
          "project-1",
          "DEPLOY_TOKEN",
          "project",
          ["runtime"],
          Redacted.make("secret-value"),
          session,
        )).state,
      ).toBe("active")
      expect(
        (yield* http.revokeEnvironment(
          origin,
          { kind: "organization", organizationId: "org-1" },
          "project-1",
          "DEPLOY_TOKEN",
          "project",
          session,
        )).state,
      ).toBe("revoked")
      expect(
        (yield* http.publishRepository(
          origin,
          "thread-1",
          "0123456789abcdef0123456789abcdef01234567",
          "main",
          "Synchronize",
          "",
          "019d1a56-286d-7000-8000-000000000001",
          session,
        )).state,
      ).toBe("completed")
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
        "/api/v1/thread-sessions",
        "/api/v1/workspace-seeds",
        "/api/v1/runners/checkout-1",
        "/api/v1/runners/checkout-1/remote-thread-creation",
        "/api/v1/runners/checkout-1/admissions",
        "/api/v1/projects",
        "/api/v1/environment/DEPLOY_TOKEN",
        "/api/v1/environment/DEPLOY_TOKEN",
        "/api/v1/threads/thread-1/repository-publications",
      ])
      for (const request of requests.slice(1)) expect(request.headers.dpop).toEqual(expect.any(String))
      expect(requests[4]?.headers.authorization).toBe("DPoP access")
      expect(bodyText(requests[0]!)).toContain('"reference_id":"cli-device:device-1"')
      expect(bodyText(requests[8]!)).toBe("")
      expect(requests[10]?.headers["content-type"]).toBe("application/vnd.rika.workspace-seed+zstd")
      expect(requests[10]?.headers["x-rika-content-digest"]).toBe(`sha256:${"d".repeat(64)}`)
      expect(requests[10]?.headers["x-rika-source-repository"]).toBe("In-Time-Tec/rika")
      const seedBody = requests[10]?.body
      if (seedBody?._tag !== "Uint8Array") return yield* Effect.die("Workspace seed request body is not binary")
      expect(Array.from(seedBody.body)).toEqual([1, 2, 3])
      expect(bodyText(requests[11]!)).toContain('"workspaceIdentity":"workspace-1"')
      expect(bodyText(requests[12]!)).toBe('{"preference":"allowed"}')
      expect(bodyText(requests[13]!)).toBe(
        '{"supervisorId":"10000000-0000-4000-8000-000000000001","activeAssignmentIds":[]}',
      )
      expect(bodyText(requests[14]!)).toContain('"name":"Remote"')
      expect(bodyText(requests[15]!)).toContain('"value":"secret-value"')
      expect(bodyText(requests[16]!)).not.toContain("secret-value")
      expect(requests[17]?.headers["idempotency-key"]).toBe("019d1a56-286d-7000-8000-000000000001")
    }),
  ),
)

it.effect("identifies a stale CLI registration from device authorization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          response(request, { error: "invalid_client", error_description: "The OAuth client does not exist" }, 400),
        ),
      )
      const context = yield* Layer.build(
        layer.pipe(Layer.provide(Layer.merge(BunCrypto.layer, Layer.succeed(HttpClient.HttpClient, client)))),
      )
      const http = Context.get(context, Http)
      const result = yield* Effect.result(
        http.startDeviceAuthorization("https://hosted.example.test", "stale-client", yield* generate()),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "registration-required", message: "CLI registration is no longer valid" },
      })
    }),
  ),
)

it.effect("reports the retry delay when token refresh is rate limited", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          response(request, { message: "Too many requests" }, 429, {
            "x-retry-after": "42",
          }),
        ),
      )
      const context = yield* Layer.build(
        layer.pipe(Layer.provide(Layer.merge(BunCrypto.layer, Layer.succeed(HttpClient.HttpClient, client)))),
      )
      const http = Context.get(context, Http)
      const result = yield* Effect.flip(
        http.refresh("https://hosted.example.test", "client-id", Redacted.make("refresh-token"), yield* generate()),
      )

      expect(result).toMatchObject({
        kind: "rate-limit",
        message: "Token refresh was rate limited; retry in 42 seconds",
        status: 429,
        retryAfterMillis: 42_000,
      })
    }),
  ),
)

it.effect("inspects and resolves interrupted Thread operations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const operation = {
        operationId: "operation-1",
        operationKey: "operation-key-1",
        runId: "run-1",
        attempt: 0,
        replayPolicy: "never",
        started: true,
        state: "needs-resolution",
        actions: ["inspect", "retry", "accept", "abort"],
        resolution: null,
      }
      const client = HttpClient.make((request) => {
        requests.push(request)
        return Effect.succeed(
          request.method === "GET"
            ? response(request, { operations: [operation] })
            : response(request, {
                ...operation,
                state: "retrying",
                actions: ["inspect"],
                resolution: { _tag: "Retry" },
              }),
        )
      })
      const context = yield* Layer.build(
        layer.pipe(Layer.provide(Layer.merge(BunCrypto.layer, Layer.succeed(HttpClient.HttpClient, client)))),
      )
      const http = Context.get(context, Http)
      const session = { accessToken: Redacted.make("access"), privateJwk: yield* generate() }
      const origin = "https://hosted.example.test"

      expect(yield* http.inspectRecovery(origin, "thread/1", "run/1", session)).toEqual([operation])
      expect(
        yield* http.resolveRecovery(
          origin,
          "thread/1",
          "run/1",
          "operation/1",
          { action: "retry" },
          "019d1a56-286d-7000-8000-000000000001",
          session,
        ),
      ).toMatchObject({ operationId: "operation-1", state: "retrying" })
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/v1/threads/thread%2F1/runs/run%2F1/recovery",
        "/api/v1/threads/thread%2F1/runs/run%2F1/recovery/operation%2F1",
      ])
      expect(requests[1]?.headers["idempotency-key"]).toBe("019d1a56-286d-7000-8000-000000000001")
      expect(bodyText(requests[1]!)).toBe('{"action":"retry"}')
    }),
  ),
)
