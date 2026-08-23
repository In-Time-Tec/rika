import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import {
  CliDeviceDirectoryError,
  IdentityDirectoryError,
  IdentityRuntimeError,
  type Account,
  type CliDeviceRegistration,
  type CliDeviceDirectory,
  type IdentityPrincipal,
  type IdentityRuntime,
} from "@rika/identity"
import { handleRequest, type HttpDependencies } from "../src/http"
import { testToolPolicy } from "./hosted-tool-policy-fixture"
import { HostedProductError, type HostedProductService } from "../src/hosted-product"
import type { Runtime as Executor } from "../src/executor"
import { isRikaApiPath, makeRikaApiHandler } from "../src/api"
import type { HostedProviderCredentialsService } from "../src/hosted-provider-credentials"
import type { HostedEnvironmentService } from "../src/hosted-environment"
import type { HostedPublicationService } from "../src/hosted-publication"
import { EnvironmentReferenceId } from "@rika/product/environment-policy"

const account: Account = {
  user: {
    id: "user-1",
    name: "Rika User",
    email: "rika@example.com",
    emailVerified: true,
    image: null,
  },
  memberships: [
    {
      id: "member-1",
      role: "owner",
      createdAt: "2026-08-19T00:00:00.000Z",
      organization: {
        id: "organization-1",
        name: "Rika",
        slug: "rika",
        logo: null,
      },
    },
  ],
}

const runtime = (userId: string | undefined): IdentityRuntime => ({
  handle: () => Effect.succeed(new Response(null, { status: 204 })),
  identify: () => Effect.succeed(userId === undefined ? undefined : { userId }),
  protectedResourceMetadata: Effect.succeed({
    resource: "https://api.example.com/api/v1",
    dpop_bound_access_tokens_required: true,
  }),
})

const devices: CliDeviceDirectory = {
  register: () => Effect.void,
  discard: () => Effect.void,
  authenticate: () => Effect.void.pipe(Effect.as(undefined as string | undefined)),
  list: () => Effect.succeed([]),
  revoke: () => Effect.succeed(false),
  revokeAll: () => Effect.void,
}

const product: HostedProductService = {
  ready: Effect.void,
  activatePrincipal: () => Effect.void,
  authorizeThread: () => Effect.fail(HostedProductError.make({ kind: "not-found", message: "Thread unavailable" })),
  threadExecutionContext: () => Effect.die("unused"),
  projects: () => Effect.succeed([]),
  createProject: () => Effect.die("unused"),
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  createConnection: () => Effect.succeed({ threadId: "thread-1" }),
  admitRun: () => Effect.die("unused"),
}

const recovery: HttpDependencies["recovery"] = {
  inspect: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
}

const executor: Executor = {
  controller: undefined as never,
  gateway: undefined as never,
  runnerGateway: undefined as never,
  admitRunner: () => Effect.die("unused"),
  admitRun: () => Effect.die("unused"),
  run: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  ready: Effect.void,
}

const execution = {
  check: Effect.succeed({ backend: "postgres" as const, source: "test", workerId: "test-worker" }),
}

const dependencies = (
  options: {
    readonly userId?: string
    readonly account?: Account
    readonly ready?: boolean
  } = {},
): HttpDependencies => ({
  identity: runtime(options.userId),
  directory: {
    ready: options.ready === false ? Effect.fail(IdentityDirectoryError.make({ operation: "readiness" })) : Effect.void,
    account: () => Effect.succeed(options.account),
  },
  devices,
  product,
  recovery,
  toolPolicy: testToolPolicy,
  executor,
  execution,
  production: true,
})

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
    (api) => Effect.promise(() => api.handler(input, undefined)),
    (api) => Effect.promise(api.dispose),
  )
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const cliRegistrationBody = {
  reference_id: "cli-device:019d1a56-286d-7000-8000-000000000001",
  token_endpoint_auth_method: "none",
  grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  scope: "openid profile email offline_access account",
  resource: "https://api.example.com/api/v1",
  dpop_jkt: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  jwk: {
    kty: "EC",
    crv: "P-256",
    x: "public-x",
    y: "public-y",
  },
} as const

describe("api HTTP", () => {
  it.effect("serves liveness without consulting identity or PostgreSQL", () =>
    Effect.gen(function* () {
      const unavailable: HttpDependencies = {
        identity: {
          handle: () => Effect.fail(IdentityRuntimeError.make({ kind: "unavailable" })),
          identify: () => Effect.fail(IdentityRuntimeError.make({ kind: "unavailable" })),
          protectedResourceMetadata: Effect.fail(IdentityRuntimeError.make({ kind: "unavailable" })),
        },
        directory: {
          ready: Effect.fail(IdentityDirectoryError.make({ operation: "readiness" })),
          account: () => Effect.fail(IdentityDirectoryError.make({ operation: "account" })),
        },
        devices,
        product: { ...product, ready: Effect.fail(HostedProductError.make({ message: "product readiness" })) },
        recovery,
        toolPolicy: testToolPolicy,
        executor,
        execution,
        production: true,
      }
      const result = yield* response("/healthz", unavailable)
      expect(result.status).toBe(200)
      expect(yield* Effect.promise(() => result.json())).toEqual({ status: "ok" })
    }),
  )

  it.effect("reports PostgreSQL readiness", () =>
    Effect.gen(function* () {
      const ready = yield* response("/readyz", dependencies({ ready: true }))
      const unavailable = yield* response("/readyz", dependencies({ ready: false }))
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
      expect(yield* Effect.promise(() => result.json())).toMatchObject({ client_id: "client-1" })
      expect(delegated?.url).toBe("https://api.example.com/api/auth/oauth2/register")
      expect(yield* Effect.promise(() => delegated!.json())).toEqual({
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
              assignmentGeneration: 1,
              leaseEpoch: 1,
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
      expect(yield* Effect.promise(() => accepted.json())).toMatchObject({
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
      expect(models.status).toBe(200)
      expect(yield* Effect.promise(() => models.json())).toEqual({ modes: ["low", "medium"] })
      expect(put.status).toBe(200)
      expect(receivedSecret).toBe("provider-api-secret")
      expect(yield* Effect.promise(() => put.text())).not.toContain("provider-api-secret")
      expect(revoke.status).toBe(200)
      expect(yield* Effect.promise(() => revoke.json())).toMatchObject({ state: "revoked", revision: "2" })
      expect(listed.status).toBe(200)
      expect(yield* Effect.promise(() => listed.json())).toEqual({ credentials: [status] })
    }),
  )

  it.effect("accepts environment material only as redacted input and returns an opaque reference", () =>
    Effect.gen(function* () {
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ account })
      let receivedSecret = ""
      const reference = {
        id: EnvironmentReferenceId.make("environment-1"),
        ownerId: "owner-1",
        scope: "personal" as const,
        scopeId: "user-1",
        name: "API_TOKEN",
        classification: "secret" as const,
        phases: ["runtime" as const],
        revision: "1",
        valueDigest: `sha256:${"a".repeat(64)}` as const,
        state: "active" as const,
        updatedByUserId: "user-1",
        updatedAt: "2026-08-21T00:00:00.000Z" as const,
      }
      const environment: HostedEnvironmentService = {
        put: (input) =>
          Effect.sync(() => {
            receivedSecret = Redacted.value(input.value)
            return reference
          }),
        revoke: () => Effect.succeed({ ...reference, revision: "2", state: "revoked" }),
        putOrganizationPolicy: () => Effect.void,
        approveSource: () => Effect.die("unused"),
        revokeSourceApproval: () => Effect.die("unused"),
        putEgress: () => Effect.die("unused"),
        usePhase: () => Effect.die("unused"),
      }
      const deps: HttpDependencies = {
        ...base,
        identity: { ...base.identity, identify: () => Effect.succeed(principal) },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        environment,
      }
      const put = yield* response("/api/v1/environment/API_TOKEN", deps, {
        method: "PUT",
        body: encodeJson({
          owner: { kind: "personal" },
          scope: "personal",
          classification: "secret",
          phases: ["runtime"],
          value: "environment-api-secret",
        }),
      })
      expect(put.status).toBe(200)
      expect(receivedSecret).toBe("environment-api-secret")
      expect(yield* Effect.promise(() => put.text())).not.toContain("environment-api-secret")
    }),
  )

  it.effect("returns the authenticated user and organization memberships", () =>
    Effect.gen(function* () {
      const result = yield* response("/api/account", dependencies({ userId: "user-1", account }))
      expect(result.status).toBe(200)
      expect(yield* Effect.promise(() => result.json())).toEqual(account)
    }),
  )

  it.effect("revokes all CLI devices only for the authenticated principal", () =>
    Effect.gen(function* () {
      const principals: Array<IdentityPrincipal> = []
      const base = dependencies({ userId: "user-1", account })
      const result = yield* response(
        "/api/v1/auth/cli/devices/revoke-all",
        {
          ...base,
          identity: {
            ...base.identity,
            identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }),
          },
          devices: {
            ...devices,
            authenticate: () => Effect.succeed("device-1"),
            revokeAll: (principal) => Effect.sync(() => void principals.push(principal)),
          },
        },
        { method: "POST" },
      )
      expect(result.status).toBe(204)
      expect(principals).toEqual([{ userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }])
    }),
  )

  it.effect("returns product projects visible to the authenticated memberships", () =>
    Effect.gen(function* () {
      const base = dependencies({ userId: "user-1", account })
      const result = yield* response("/api/v1/me/context", {
        ...base,
        identity: {
          ...base.identity,
          identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
        },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        product: {
          ...product,
          projects: (principal) => {
            expect(principal).toEqual({ userId: "user-1", clientId: "client-1", deviceId: "device-1" })
            return Effect.succeed([
              {
                id: "project-1",
                ownerId: "owner-1",
                owner: { _tag: "OrganizationOwner", organizationId: "organization-1" as never },
                name: "API",
                role: "owner",
              },
            ])
          },
        },
      })
      expect(result.status).toBe(200)
      const body = yield* Effect.promise(() => result.json() as Promise<{ readonly projects: unknown }>)
      expect(body.projects).toEqual([
        {
          id: "project-1",
          ownerId: "owner-1",
          owner: { kind: "organization", organizationId: "organization-1" },
          name: "API",
          slug: "api",
        },
      ])
    }),
  )

  it.effect("creates and returns a selected-owner Project", () =>
    Effect.gen(function* () {
      const base = dependencies({ userId: "user-1", account })
      const result = yield* response(
        "/api/v1/projects",
        {
          ...base,
          identity: {
            ...base.identity,
            identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
          },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          product: {
            ...product,
            createProject: (input) => {
              expect(input.principal).toEqual({ userId: "user-1", clientId: "client-1", deviceId: "device-1" })
              expect(input.owner).toEqual({ _tag: "OrganizationOwner", organizationId: "organization-1" })
              expect(input.name).toBe("Remote Platform")
              return Effect.succeed({
                id: "project-2",
                ownerId: "owner-1",
                owner: { _tag: "OrganizationOwner", organizationId: "organization-1" as never },
                name: "Remote Platform",
                role: "owner",
              })
            },
          },
        },
        {
          method: "POST",
          body: encodeJson({
            owner: { kind: "organization", organization_id: "organization-1" },
            name: "Remote Platform",
          }),
        },
      )
      expect(result.status).toBe(201)
      expect(yield* Effect.promise(() => result.json())).toEqual({
        id: "project-2",
        ownerId: "owner-1",
        owner: { kind: "organization", organizationId: "organization-1" },
        name: "Remote Platform",
        slug: "remote-platform",
      })
    }),
  )

  it.effect("invites through Better Auth only for an authenticated organization membership", () =>
    Effect.gen(function* () {
      let forwarded: Request | undefined
      const base = dependencies({ userId: "user-1", account })
      const accepted = yield* response(
        "/api/v1/organizations/organization-1/invitations",
        {
          ...base,
          identity: {
            ...base.identity,
            handle: (forwardedRequest) => {
              forwarded = forwardedRequest
              return Effect.succeed(Response.json({ id: "invite-1", email: "new@example.test" }))
            },
          },
        },
        { method: "POST", body: encodeJson({ email: "new@example.test" }) },
      )
      const rejected = yield* response("/api/v1/organizations/foreign/invitations", base, {
        method: "POST",
        body: encodeJson({ email: "new@example.test" }),
      })
      expect(accepted.status).toBe(200)
      expect(rejected.status).toBe(404)
      expect(forwarded?.url).toBe("https://api.example.com/api/auth/organization/invite-member")
      expect(yield* Effect.promise(() => forwarded!.json())).toEqual({
        email: "new@example.test",
        organizationId: "organization-1",
        role: "member",
      })
    }),
  )

  it.effect("issues a single-use Thread socket ticket from authenticated device authority", () =>
    Effect.gen(function* () {
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ userId: "user-1", account })
      let received: unknown
      const result = yield* response(
        "/api/v1/thread-sessions",
        {
          ...base,
          identity: { ...base.identity, identify: () => Effect.succeed(principal) },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          threads: {
            issueTicket: (value) => {
              received = value
              return Effect.succeed({ ticket: "socket-ticket", expiresAt: "2026-08-19T00:01:00.000Z" })
            },
            connect: () => Effect.die("unused"),
          },
        },
        { method: "POST" },
      )
      expect(result.status).toBe(201)
      expect(received).toEqual({
        userId: "user-1",
        deviceId: "device-1",
        clientId: "client-1",
        dpopJkt: "thumbprint-1",
      })
      expect(yield* Effect.promise(() => result.json())).toEqual({
        ticket: "socket-ticket",
        expiresAt: "2026-08-19T00:01:00.000Z",
        websocketUrl: "wss://api.example.com/api/v1/threads/socket",
        protocol: "rika.thread.v1",
      })
    }),
  )

  it.effect("does not expose the replaced connection and operation endpoints", () =>
    Effect.gen(function* () {
      const deps = dependencies({ userId: "user-1", account })
      const connection = yield* response("/api/v1/connections", deps, {
        method: "POST",
        body: encodeJson({}),
      })
      const operation = yield* response("/api/v1/threads/thread-1/operations", deps, {
        method: "POST",
        body: encodeJson({}),
      })
      expect(connection.status).toBe(404)
      expect(operation.status).toBe(404)
    }),
  )

  it.effect("rejects client-supplied ownership fields for local admission", () =>
    Effect.gen(function* () {
      const base = dependencies({ account })
      const deps: HttpDependencies = {
        ...base,
        identity: {
          ...base.identity,
          identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
        },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
      }
      for (const body of [
        { workspace_fingerprint: "workspace-1", organization_id: "organization-1" },
        { workspace_fingerprint: "workspace-1", member_id: "member-1" },
      ]) {
        const result = yield* response("/api/v1/threads/thread-2/runner-admissions", deps, {
          method: "POST",
          body: encodeJson(body),
        })
        expect(result.status).toBe(400)
      }
    }),
  )

  it.effect("returns secured JSON 404 responses for web pages and assets", () =>
    Effect.gen(function* () {
      for (const path of [
        "/",
        "/login",
        "/signup",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/assets/web.css",
      ]) {
        const result = yield* response(path)
        expect(result.status).toBe(404)
        expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8")
        expect(result.headers.get("x-content-type-options")).toBe("nosniff")
        expect(yield* Effect.promise(() => result.json())).toEqual({ message: "Not found" })
      }
    }),
  )

  it.effect("allows a personal account to approve a device without an organization", () =>
    Effect.gen(function* () {
      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const api = yield* response("/api/auth/device/approve", withoutOrganization, { method: "POST" })
      expect(api.status).toBe(204)
    }),
  )

  it.effect("requires authentication but no organization at OAuth authorization", () =>
    Effect.gen(function* () {
      const path = "/api/auth/oauth2/authorize?client_id=client-1&response_type=code"
      const anonymous = yield* response(path)
      expect(anonymous.status).toBe(303)
      expect(anonymous.headers.get("location")).toContain("/login?redirect=")

      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const personal = yield* response(path, withoutOrganization)
      expect(personal.status).toBe(204)
    }),
  )

  it.effect("publishes DPoP protected-resource metadata", () =>
    Effect.gen(function* () {
      const result = yield* response("/.well-known/oauth-protected-resource/api/v1")
      expect(result.status).toBe(200)
      expect(yield* Effect.promise(() => result.json())).toEqual({
        resource: "https://api.example.com/api/v1",
        dpop_bound_access_tokens_required: true,
      })
    }),
  )
})
