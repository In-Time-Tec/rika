import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import {
  CliDeviceDirectoryError,
  IdentityDirectoryError,
  IdentityRuntimeError,
  type CliDeviceRegistration,
  type IdentityPrincipal,
} from "@rika/identity"
import { handleRequest, type HttpDependencies } from "../../src/server/http"
import { HostedProductError } from "../../src/hosted/product"
import type { HostedProviderCredentialsService } from "../../src/hosted/environment/provider-credentials"
import type { HostedPublicationService } from "../../src/hosted/publication"
import {
  AssignmentLeaseEpoch,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  FencingGeneration,
  OwnerId,
} from "@rika/product/hosted-model"
import { ThreadId } from "@rika/product/thread-record"

import { isRikaApiPath, makeRikaApiHandler } from "../../src/api"
import { httpFixture } from "./http/fixture"
import "./http/product.harness"
import "./http/security.harness"
import "./http/browser-read.harness"
const { account, cliRegistrationBody, dependencies, devices, encodeJson, executor, execution, product, recovery } =
  httpFixture

const request = (path: string, options?: RequestInit) => {
  const headers = new Headers(options?.headers)
  if (options?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  return new Request(`https://api.example.com${path}`, { ...options, headers })
}

const response = (path: string, deps = dependencies(), options?: RequestInit) => {
  const input = request(path, options)
  if (!isRikaApiPath(new URL(input.url).pathname)) return handleRequest({ request: input, dependencies: deps })
  return Effect.acquireUseRelease(
    Effect.sync(() => makeRikaApiHandler(deps)),
    (api) => Effect.tryPromise(() => api.handler(input, undefined)),
    (api) => Effect.tryPromise(api.dispose),
  )
}

describe("api HTTP", () => {
  it.effect("does not expose an authentication bypass in development or production", () =>
    Effect.gen(function* () {
      const development: HttpDependencies = {
        ...dependencies(),
        production: false,
      }
      const local = yield* response("/__dev/log-me-in/rika%40local.test", development)
      const production = yield* response("/__dev/log-me-in/rika%40local.test", dependencies())
      expect(local.status).toBe(404)
      expect(production.status).toBe(404)
    }),
  )

  it.effect("serves liveness without consulting identity or PostgreSQL", () =>
    Effect.gen(function* () {
      const unavailable: HttpDependencies = {
        identity: {
          handle: () => Effect.fail(IdentityRuntimeError.make({ kind: "unavailable" })),
          identify: () => Effect.fail(IdentityRuntimeError.make({ kind: "unavailable" })),
          browserSession: () => Effect.die("unused"),
          protectedResourceMetadata: Effect.fail(IdentityRuntimeError.make({ kind: "unavailable" })),
        },
        directory: {
          ready: Effect.fail(IdentityDirectoryError.make({ operation: "readiness" })),
          account: () => Effect.fail(IdentityDirectoryError.make({ operation: "account" })),
        },
        devices,
        product: { ...product, ready: Effect.fail(HostedProductError.make({ message: "product readiness" })) },
        recovery,
        executor,
        execution,
        production: true,
      }
      const result = yield* response("/healthz", unavailable)
      expect(result.status).toBe(200)
      expect(yield* Effect.tryPromise(() => result.json())).toEqual({ status: "ok" })
    }),
  )

  it.effect("reports PostgreSQL readiness", () =>
    Effect.gen(function* () {
      const status = yield* execution.status
      const ready = yield* response("/readyz", dependencies({ ready: true }))
      const unavailable = yield* response("/readyz", dependencies({ ready: false }))
      expect(status).toMatchObject({
        execution: { worker: "execution" },
        turn: { worker: "turn", oldestClaimAgeMillis: 10 },
        projection: { worker: "projection", oldestActiveProjectionAgeMillis: 20 },
      })
      expect(ready.status).toBe(200)
      expect(unavailable.status).toBe(503)
    }),
  )

  it.effect("rejects an unauthenticated account request", () =>
    Effect.gen(function* () {
      const result = yield* response("/api/account")
      expect(result.status).toBe(401)
      expect(result.headers.get("www-authenticate")).toBe('Bearer realm="rika"')
    }),
  )

  it.effect("delegates unauthenticated dynamic registration to Better Auth", () =>
    Effect.gen(function* () {
      const result = yield* response("/api/auth/oauth2/register", dependencies(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"token_endpoint_auth_method":"none"}',
      })
      expect(result.status).toBe(204)
      expect(result.headers.get("x-content-type-options")).toBe("nosniff")
    }),
  )

  it.effect("registers a CLI OAuth client and installation binding as one public operation", () =>
    Effect.gen(function* () {
      let delegated: Request | undefined
      let registered: CliDeviceRegistration | undefined
      const base = dependencies()
      const result = yield* response(
        "/api/v1/auth/cli/registrations",
        {
          ...base,
          identity: {
            ...base.identity,
            handle: (forwardedRequest) => {
              delegated = forwardedRequest
              return Effect.succeed(
                Response.json({ client_id: "client-1", token_endpoint_auth_method: "none" }, { status: 201 }),
              )
            },
          },
          devices: {
            ...devices,
            register: (input) => {
              registered = input
              return Effect.void
            },
          },
        },
        { method: "POST", body: encodeJson(cliRegistrationBody) },
      )
      expect(result.status).toBe(201)
      expect(yield* Effect.tryPromise(() => result.json())).toMatchObject({ client_id: "client-1" })
      expect(delegated?.url).toBe("https://api.example.com/api/auth/oauth2/register")
      expect(yield* Effect.tryPromise(() => delegated!.json())).toEqual({
        client_name: "Rika CLI",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        scope: "openid profile email offline_access account",
        software_id: "rika-cli",
        dpop_bound_access_tokens: true,
        resources: ["https://api.example.com/api/v1"],
      })
      expect(registered).toEqual({
        clientId: "client-1",
        deviceId: "019d1a56-286d-7000-8000-000000000001",
        publicJwk: cliRegistrationBody.jwk,
        jwkThumbprint: cliRegistrationBody.dpop_jkt,
      })
    }),
  )

  it.effect("removes the OAuth client when its installation binding cannot be persisted", () =>
    Effect.gen(function* () {
      const discarded: Array<string> = []
      const base = dependencies()
      const result = yield* response(
        "/api/v1/auth/cli/registrations",
        {
          ...base,
          identity: {
            ...base.identity,
            handle: () => Effect.succeed(Response.json({ client_id: "client-2" }, { status: 201 })),
          },
          devices: {
            ...devices,
            register: () => Effect.fail(CliDeviceDirectoryError.make({ operation: "register CLI device" })),
            discard: (clientId) => Effect.sync(() => void discarded.push(clientId)),
          },
        },
        { method: "POST", body: encodeJson(cliRegistrationBody) },
      )
      expect(result.status).toBe(503)
      expect(discarded).toEqual(["client-2"])
    }),
  )

  it.effect("requires the verified OAuth client and DPoP key to match a registered installation", () =>
    Effect.gen(function* () {
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ account })
      const withDevice = (authenticated: boolean): HttpDependencies => ({
        ...base,
        identity: { ...base.identity, identify: () => Effect.succeed(principal) },
        devices: {
          ...devices,
          authenticate: () => Effect.succeed(authenticated ? "device-1" : undefined),
        },
      })
      const accepted = yield* response("/api/v1/me/context", withDevice(true))
      const rejected = yield* response("/api/v1/me/context", withDevice(false))
      expect(accepted.status).toBe(200)
      expect(rejected.status).toBe(401)
    }),
  )

  it.effect("lists and previews only Threads authorized for the authenticated device", () =>
    Effect.gen(function* () {
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ account: { ...account, memberships: [] } })
      const visible = {
        id: ThreadId.make("thread-visible"),
        workspace: "workspace-1",
        title: "Visible Thread",
        pinned: false,
        archived: false,
        status: "idle" as const,
        unread: false,
        lastActivityAt: 1,
        turnCount: 1,
      }
      const hidden = { ...visible, id: ThreadId.make("thread-hidden"), title: "Hidden Thread" }
      const deps: HttpDependencies = {
        ...base,
        identity: { ...base.identity, identify: () => Effect.succeed(principal) },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        product: {
          ...product,
          authorizeOwner: (receivedPrincipal, owner) => {
            expect(receivedPrincipal).toMatchObject({ ...principal, deviceId: "device-1" })
            expect(owner).toMatchObject({ _tag: "PersonalOwner", userId: "user-1" })
            return Effect.succeed({ ownerId: OwnerId.make("owner-1") })
          },
          authorizeThread: (_receivedPrincipal, threadId) =>
            threadId === "thread-hidden"
              ? Effect.fail(HostedProductError.make({ kind: "forbidden", message: "hidden" }))
              : Effect.succeed({
                  ownerId: OwnerId.make("owner-1"),
                  actor: {
                    _tag: "PersonalActor",
                    owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make("user-1") },
                    userId: BetterAuthUserId.make("user-1"),
                    clientId: ClientId.make("client-1"),
                    deviceId: DeviceId.make("device-1"),
                  },
                }),
        },
        threadApplication: {
          threads: (ownerId, projectId) => {
            expect(ownerId).toBe("owner-1")
            expect(projectId).toBeUndefined()
            return Effect.succeed([visible, hidden])
          },
          preview: (ownerId, threadId) => {
            expect(ownerId).toBe("owner-1")
            expect(threadId).toBe("thread-visible")
            return Effect.succeed([])
          },
          thread: () => Effect.die("unused"),
          interactive: () => Effect.die("unused"),
          snapshot: () => Effect.die("unused"),
          projectionCommitted: () => Effect.die("unused"),
        },
      }
      const listed = yield* response("/api/v1/threads/list", deps, {
        method: "POST",
        body: encodeJson({ owner: { kind: "personal" } }),
      })
      const preview = yield* response("/api/v1/threads/thread-visible/preview", deps)
      expect(listed.status).toBe(200)
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ threads: [visible] })
      expect(preview.status).toBe(200)
      expect(yield* Effect.tryPromise(() => preview.json())).toEqual({ units: [] })
    }),
  )

  it.effect("publishes only an authenticated device's approved repository commit", () =>
    Effect.gen(function* () {
      const base = dependencies({ account: { ...account, memberships: [] } })
      const calls: Array<Parameters<HostedPublicationService["publish"]>[0]> = []
      const publication: HostedPublicationService = {
        publish: (input) =>
          Effect.sync(() => {
            calls.push(input)
            return {
              id: "publication-1",
              ownerId: "owner-1",
              threadId: input.threadId,
              projectId: "project-1",
              repositoryId: "repository-1",
              assignmentId: "assignment-1",
              assignmentGeneration: FencingGeneration.make("1"),
              leaseEpoch: AssignmentLeaseEpoch.make("1"),
              workspaceId: "workspace-1",
              authorizationCheckpointId: "publication-1",
              authorizationDigest: `sha256:${"a".repeat(64)}`,
              sourceBranch: `rika/${input.threadId}`,
              sourceRef: `refs/heads/rika/${input.threadId}`,
              sourceCommitSha: input.commitSha,
              target: { ref: "main", commitSha: "c".repeat(40), protected: true },
              title: input.title,
              body: input.body,
              state: "completed" as const,
              pushResult: { outcome: "succeeded" },
              pullRequestResult: { outcome: "succeeded", number: 7 },
            }
          }),
      }
      const deps: HttpDependencies = {
        ...base,
        identity: {
          ...base.identity,
          identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
        },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        publication,
      }
      const headers = { "idempotency-key": "11111111-1111-4111-8111-111111111111" }
      const commitSha = "b".repeat(40)
      const accepted = yield* response("/api/v1/threads/thread-1/repository-publications", deps, {
        method: "POST",
        headers,
        body: encodeJson({ commit_sha: commitSha, title: "Publish thread-1", body: "Approved publication" }),
      })
      expect(accepted.status).toBe(200)
      expect(yield* Effect.tryPromise(() => accepted.json())).toMatchObject({
        state: "completed",
        branch: "rika/thread-1",
        ref: "refs/heads/rika/thread-1",
        commitSha,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        principal: { userId: "user-1", clientId: "client-1", deviceId: "device-1" },
        threadId: "thread-1",
        idempotencyKey: headers["idempotency-key"],
        commitSha,
      })
      const rejected = yield* response("/api/v1/threads/thread-1/repository-publications", deps, {
        method: "POST",
        headers,
        body: encodeJson({
          commit_sha: commitSha,
          source_branch: "attacker/branch",
          title: "Publish thread-1",
          body: "Approved publication",
        }),
      })
      expect(rejected.status).toBe(400)
      expect(calls).toHaveLength(1)
    }),
  )

  it.effect("manages provider credentials without returning secret material", () =>
    Effect.gen(function* () {
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ account })
      let receivedSecret = ""
      let receivedOpenAiTokens: ReadonlyArray<string> = []
      const status = {
        provider: "openai" as const,
        state: "active" as const,
        revision: "1",
        credentialIdentity: "provider-credential-1",
      }
      const credentials: HostedProviderCredentialsService = {
        put: (input) =>
          Effect.sync(() => {
            receivedSecret = Redacted.value(input.apiKey)
            return status
          }),
        revoke: () => Effect.succeed({ ...status, state: "revoked", revision: "2" }),
        list: () => Effect.succeed([status]),
        require: () => Effect.succeed(status),
        putOpenAiAccount: (input) =>
          Effect.sync(() => {
            receivedOpenAiTokens = [
              Redacted.value(input.accessToken),
              Redacted.value(input.idToken),
              Redacted.value(input.refreshToken),
            ]
            return {
              state: "active" as const,
              revision: "1",
              credentialIdentity: "openai-account-1",
              fingerprint: "openai-fingerprint-1",
            }
          }),
        revokeOpenAiAccount: () =>
          Effect.succeed({
            state: "revoked" as const,
            revision: "2",
            credentialIdentity: "openai-account-1",
            fingerprint: "openai-fingerprint-1",
          }),
        openAiAccountStatus: () =>
          Effect.succeed({
            state: "active" as const,
            revision: "1",
            credentialIdentity: "openai-account-1",
            fingerprint: "openai-fingerprint-1",
          }),
        requireOpenAiAccount: () => Effect.die("unused"),
        openAiAccountAccess: () => ({ acquire: Effect.die("unused"), refreshRejected: () => Effect.die("unused") }),
      }
      const deps: HttpDependencies = {
        ...base,
        identity: { ...base.identity, identify: () => Effect.succeed(principal) },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        credentials,
        models: { modes: ["low", "medium"], resolve: () => Effect.die("unused") },
      }
      const models = yield* response("/api/v1/models", deps)
      const put = yield* response("/api/v1/provider-credentials/openai", deps, {
        method: "PUT",
        body: encodeJson({ owner: { kind: "personal" }, api_key: "provider-api-secret" }),
      })
      const revoke = yield* response("/api/v1/provider-credentials/openai", deps, {
        method: "DELETE",
        body: encodeJson({ owner: { kind: "personal" } }),
      })
      const listed = yield* response("/api/v1/provider-credentials/list", deps, {
        method: "POST",
        body: encodeJson({ owner: { kind: "personal" } }),
      })
      const putOpenAi = yield* response("/api/v1/provider-accounts/openai", deps, {
        method: "PUT",
        body: encodeJson({
          owner: { kind: "personal" },
          access_token: "oauth-access-secret",
          id_token: "oauth-identity-secret",
          refresh_token: "oauth-refresh-secret",
        }),
      })
      const getOpenAi = yield* response("/api/v1/provider-accounts/openai/status", deps, {
        method: "POST",
        body: encodeJson({ owner: { kind: "personal" } }),
      })
      const revokeOpenAi = yield* response("/api/v1/provider-accounts/openai", deps, {
        method: "DELETE",
        body: encodeJson({ owner: { kind: "personal" } }),
      })
      expect(models.status).toBe(200)
      expect(yield* Effect.tryPromise(() => models.json())).toEqual({ modes: ["low", "medium"] })
      expect(put.status).toBe(200)
      expect(receivedSecret).toBe("provider-api-secret")
      expect(yield* Effect.tryPromise(() => put.text())).not.toContain("provider-api-secret")
      expect(revoke.status).toBe(200)
      expect(yield* Effect.tryPromise(() => revoke.json())).toMatchObject({ state: "revoked", revision: "2" })
      expect(listed.status).toBe(200)
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ credentials: [status] })
      expect(putOpenAi.status).toBe(200)
      expect(receivedOpenAiTokens).toEqual(["oauth-access-secret", "oauth-identity-secret", "oauth-refresh-secret"])
      expect(yield* Effect.tryPromise(() => putOpenAi.text())).not.toMatch(/oauth-(?:access|identity|refresh)-secret/u)
      expect(getOpenAi.status).toBe(200)
      expect(yield* Effect.tryPromise(() => getOpenAi.json())).toMatchObject({
        state: "active",
        credentialIdentity: "openai-account-1",
        fingerprint: "openai-fingerprint-1",
      })
      expect(revokeOpenAi.status).toBe(200)
      expect(yield* Effect.tryPromise(() => revokeOpenAi.json())).toMatchObject({ state: "revoked", revision: "2" })
    }),
  )
})
