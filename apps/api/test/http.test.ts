import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
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
import { HostedProductError, type HostedProductService } from "../src/hosted-product"
import type { Runtime as Executor } from "../src/executor"
import { isRikaApiPath, makeRikaApiHandler } from "../src/api"

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
  handle: () => Effect.succeed(new Response("delegated", { status: 204 })),
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
  projects: () => Effect.succeed([]),
  createConnection: () => Effect.succeed({ threadId: "thread-1" }),
  admitRun: () => Effect.die("unused"),
}

const executor: Executor = {
  controller: undefined as never,
  gateway: undefined as never,
  localGateway: undefined as never,
  admitLocal: () => Effect.die("unused"),
  run: () => Effect.die("unused"),
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
  executor,
  execution,
  production: true,
})

const request = (path: string, options?: RequestInit) => new Request(`https://api.example.com${path}`, options)

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

  it.effect("creates connections from authenticated membership and device authority", () =>
    Effect.gen(function* () {
      let input: Parameters<HostedProductService["createConnection"]>[0] | undefined
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ userId: "user-1", account })
      const result = yield* response(
        "/api/v1/connections",
        {
          ...base,
          identity: { ...base.identity, identify: () => Effect.succeed(principal) },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          product: {
            ...product,
            createConnection: (value) => {
              input = value
              return Effect.succeed({ threadId: "thread-1" })
            },
          },
        },
        {
          method: "POST",
          body: encodeJson({
            owner: { kind: "organization", organization_id: "organization-1" },
            project_id: "project-1",
            placement: "e2b",
          }),
        },
      )
      expect(result.status).toBe(201)
      expect(input).toEqual({
        principal: {
          userId: "user-1",
          deviceId: "device-1",
          clientId: "client-1",
          dpopJkt: "thumbprint-1",
        },
        owner: { _tag: "OrganizationOwner", organizationId: "organization-1" },
        projectId: "project-1",
        placement: "e2b",
      })
    }),
  )

  it.effect("supports context and personal connections for a CLI user with no organizations", () =>
    Effect.gen(function* () {
      const personalAccount = { ...account, memberships: [] }
      const base = dependencies({ account: personalAccount })
      let connection: Parameters<HostedProductService["createConnection"]>[0] | undefined
      const deps: HttpDependencies = {
        ...base,
        identity: {
          ...base.identity,
          identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
        },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        product: {
          ...product,
          projects: () => Effect.succeed([]),
          createConnection: (input) => {
            connection = input
            return Effect.succeed({ threadId: "thread-1" })
          },
        },
      }
      const context = yield* response("/api/v1/me/context", deps)
      const created = yield* response("/api/v1/connections", deps, {
        method: "POST",
        body: encodeJson({ owner: { kind: "personal" } }),
      })
      expect(context.status).toBe(200)
      expect(yield* Effect.promise(() => context.json())).toEqual({
        account: { id: "user-1", email: "rika@example.com", name: "Rika User" },
        organizations: [],
        projects: [],
      })
      expect(created.status).toBe(201)
      expect(connection).toEqual({
        principal: { userId: "user-1", clientId: "client-1", deviceId: "device-1" },
        owner: { _tag: "PersonalOwner", userId: "user-1" },
        placement: "local",
      })
    }),
  )

  it.effect("rejects a mixed personal and organization owner selector", () =>
    Effect.gen(function* () {
      const base = dependencies({ account })
      const result = yield* response(
        "/api/v1/connections",
        {
          ...base,
          identity: {
            ...base.identity,
            identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
          },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        },
        {
          method: "POST",
          body: encodeJson({ owner: { kind: "personal", organization_id: "organization-1" } }),
        },
      )
      expect(result.status).toBe(400)
    }),
  )

  it.effect("forwards an organization selector without membership identity", () =>
    Effect.gen(function* () {
      const base = dependencies({ account })
      let input: Parameters<HostedProductService["createConnection"]>[0] | undefined
      const result = yield* response(
        "/api/v1/connections",
        {
          ...base,
          identity: {
            ...base.identity,
            identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
          },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          product: {
            ...product,
            createConnection: (value) => Effect.sync(() => ((input = value), { threadId: "thread-1" })),
          },
        },
        {
          method: "POST",
          body: encodeJson({ owner: { kind: "organization", organization_id: "organization-1" } }),
        },
      )
      expect(result.status).toBe(201)
      expect(input).toEqual({
        principal: { userId: "user-1", clientId: "client-1", deviceId: "device-1" },
        owner: { _tag: "OrganizationOwner", organizationId: "organization-1" },
        placement: "local",
      })
      expect(input).not.toHaveProperty("membershipId")
    }),
  )

  it.effect("rejects client-supplied ownership fields for local admission and runs", () =>
    Effect.gen(function* () {
      const operationKey = "019d1a56-286d-7000-8000-000000000005"
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
        const result = yield* response("/api/v1/threads/local_thread-1/local-executor-admissions", deps, {
          method: "POST",
          body: encodeJson(body),
        })
        expect(result.status).toBe(400)
      }
      for (const obsolete of [{ organization_id: "organization-1" }, { member_id: "member-1" }]) {
        const result = yield* response("/api/v1/threads/e2b_thread-1/operations", deps, {
          method: "POST",
          headers: { "idempotency-key": operationKey },
          body: encodeJson({ kind: "run", prompt: ["echo clean"], ...obsolete }),
        })
        expect(result.status).toBe(400)
      }
    }),
  )

  it.effect("acknowledges durable admission without executing in the HTTP request", () =>
    Effect.gen(function* () {
      const operationKey = "019d1a56-286d-7000-8000-000000000002"
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ userId: "user-1", account })
      let admitted: Parameters<HostedProductService["admitRun"]>[0] | undefined
      let executed = false
      const result = yield* response(
        "/api/v1/threads/e2b_thread-1/operations",
        {
          ...base,
          identity: { ...base.identity, identify: () => Effect.succeed(principal) },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          product: {
            ...product,
            admitRun: (input) => {
              admitted = input
              return Effect.succeed({ commandId: operationKey, turnId: "turn-1", status: "queued" })
            },
          },
          executor: {
            ...executor,
            run: () => {
              executed = true
              return Effect.die("HTTP must not execute admitted work")
            },
          },
        },
        {
          method: "POST",
          headers: { "idempotency-key": operationKey },
          body: encodeJson({ kind: "run", prompt: ["echo hosted-mvp"] }),
        },
      )
      expect(result.status).toBe(202)
      expect(yield* Effect.promise(() => result.json())).toEqual({
        commandId: operationKey,
        turnId: "turn-1",
        status: "queued",
      })
      expect(admitted).toEqual({
        principal: {
          userId: "user-1",
          deviceId: "device-1",
          clientId: "client-1",
          dpopJkt: "thumbprint-1",
        },
        threadId: "e2b_thread-1",
        operationKey,
        prompt: "echo hosted-mvp",
      })
      expect(executed).toBe(false)
    }),
  )

  it.effect("returns the original durable admission without redispatching", () =>
    Effect.gen(function* () {
      const operationKey = "019d1a56-286d-7000-8000-000000000004"
      const base = dependencies({ userId: "user-1", account })
      let dispatched = false
      const result = yield* response(
        "/api/v1/threads/e2b_thread-1/operations",
        {
          ...base,
          identity: {
            ...base.identity,
            identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
          },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          product: {
            ...product,
            admitRun: () =>
              Effect.succeed({ commandId: operationKey, turnId: "original-turn", status: "queued" }),
          },
          executor: {
            ...executor,
            run: () => {
              dispatched = true
              return Effect.die("must not redispatch")
            },
          },
        },
        {
          method: "POST",
          headers: { "idempotency-key": operationKey },
          body: encodeJson({ kind: "run", prompt: ["echo hosted-mvp"] }),
        },
      )
      expect(result.status).toBe(202)
      expect(yield* Effect.promise(() => result.json())).toEqual({
        commandId: operationKey,
        turnId: "original-turn",
        status: "queued",
      })
      expect(dispatched).toBe(false)
    }),
  )

  it.effect("reports an idempotency conflict without dispatching", () =>
    Effect.gen(function* () {
      const operationKey = "019d1a56-286d-7000-8000-000000000003"
      const base = dependencies({ userId: "user-1", account })
      let dispatched = false
      const result = yield* response(
        "/api/v1/threads/e2b_thread-1/operations",
        {
          ...base,
          identity: {
            ...base.identity,
            identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
          },
          devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
          product: {
            ...product,
            admitRun: () =>
              Effect.fail(HostedProductError.make({ kind: "conflict", message: "conflicting operation" })),
          },
          executor: {
            ...executor,
            run: () => {
              dispatched = true
              return Effect.die("must not dispatch")
            },
          },
        },
        {
          method: "POST",
          headers: { "idempotency-key": operationKey },
          body: encodeJson({ kind: "run", prompt: ["different"] }),
        },
      )
      expect(result.status).toBe(409)
      expect(dispatched).toBe(false)
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

  it.effect("requires an organization before device approval", () =>
    Effect.gen(function* () {
      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const api = yield* response("/api/auth/device/approve", withoutOrganization, { method: "POST" })
      expect(api.status).toBe(403)
    }),
  )

  it.effect("requires authentication and an organization at OAuth authorization", () =>
    Effect.gen(function* () {
      const path = "/api/auth/oauth2/authorize?client_id=client-1&response_type=code"
      const anonymous = yield* response(path)
      expect(anonymous.status).toBe(303)
      expect(anonymous.headers.get("location")).toContain("/login?redirect=")

      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const onboarding = yield* response(path, withoutOrganization)
      expect(onboarding.status).toBe(303)
      expect(onboarding.headers.get("location")).toContain("/organizations/new?redirect=")
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
