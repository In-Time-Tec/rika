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
    resource: "https://control.example.com/api/v1",
    dpop_bound_access_tokens_required: true,
  }),
})

const devices: CliDeviceDirectory = {
  register: () => Effect.void,
  discard: () => Effect.void,
  authenticate: () => Effect.void.pipe(Effect.as(undefined as string | undefined)),
  list: () => Effect.succeed([]),
  revoke: () => Effect.succeed(false),
}

const product: HostedProductService = {
  ready: Effect.void,
  projects: () => Effect.succeed([]),
  createConnection: () => Effect.succeed({ threadId: "thread-1" }),
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
  production: true,
})

const request = (path: string, options?: RequestInit) => new Request(`https://control.example.com${path}`, options)

const response = (path: string, deps = dependencies(), options?: RequestInit) =>
  handleRequest({ request: request(path, options), dependencies: deps })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const cliRegistrationBody = {
  reference_id: "cli-device:019d1a56-286d-7000-8000-000000000001",
  token_endpoint_auth_method: "none",
  grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  scope: "openid profile email offline_access account",
  resource: "https://control.example.com/api/v1",
  dpop_jkt: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  jwk: {
    kty: "EC",
    crv: "P-256",
    x: "public-x",
    y: "public-y",
  },
} as const

describe("control-plane HTTP", () => {
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
      expect(delegated?.url).toBe("https://control.example.com/api/auth/oauth2/register")
      expect(yield* Effect.promise(() => delegated!.json())).toEqual({
        client_name: "Rika CLI",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        scope: "openid profile email offline_access account",
        software_id: "rika-cli",
        dpop_bound_access_tokens: true,
        resources: ["https://control.example.com/api/v1"],
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

  it.effect("returns product projects visible to the authenticated memberships", () =>
    Effect.gen(function* () {
      const result = yield* response("/api/v1/me/context", {
        ...dependencies({ userId: "user-1", account }),
        product: {
          ...product,
          projects: (memberIds) => {
            expect(memberIds).toEqual(["member-1"])
            return Effect.succeed([
              { id: "project-1", organizationId: "organization-1", name: "Control Plane", role: "owner" },
            ])
          },
        },
      })
      expect(result.status).toBe(200)
      const body = yield* Effect.promise(() => result.json() as Promise<{ readonly projects: unknown }>)
      expect(body.projects).toEqual([
        { id: "project-1", organizationId: "organization-1", name: "Control Plane", slug: "control-plane" },
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
      expect(forwarded?.url).toBe("https://control.example.com/api/auth/organization/invite-member")
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
          body: encodeJson({ organization_id: "organization-1", project_id: "project-1", placement: "e2b" }),
        },
      )
      expect(result.status).toBe(201)
      expect(input).toEqual({
        authority: {
          organizationId: "organization-1",
          memberId: "member-1",
          deviceId: "device-1",
          clientId: "client-1",
          dpopJkt: "thumbprint-1",
        },
        projectId: "project-1",
        placement: "e2b",
      })
    }),
  )

  it.effect("serves accessible public identity pages", () =>
    Effect.gen(function* () {
      for (const path of ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"]) {
        const result = yield* response(path)
        const body = yield* Effect.promise(() => result.text())
        expect(result.status).toBe(200)
        expect(body).toContain('<html lang="en">')
        expect(body).toContain('role="status"')
        expect(body).toContain("<h1>")
      }
    }),
  )

  it.effect("preserves invitation redirects through login and signup", () =>
    Effect.gen(function* () {
      const invitation = yield* response("/invitations/invitation-1")
      expect(invitation.status).toBe(303)
      expect(invitation.headers.get("location")).toBe("/login?redirect=%2Finvitations%2Finvitation-1")

      const login = yield* response("/login?redirect=%2Finvitations%2Finvitation-1")
      const body = yield* Effect.promise(() => login.text())
      expect(body).toContain('data-redirect="/invitations/invitation-1"')
      expect(body).toContain("/signup?redirect=%2Finvitations%2Finvitation-1")
    }),
  )

  it.effect("rejects cross-origin authentication redirects", () =>
    Effect.gen(function* () {
      const result = yield* response("/login?redirect=%2F%5C%5Cexample.net")
      const body = yield* Effect.promise(() => result.text())
      expect(result.status).toBe(200)
      expect(body).toContain('data-redirect="/"')
      expect(body).not.toContain("example.net")
    }),
  )

  it.effect("preserves the verification callback", () =>
    Effect.gen(function* () {
      const result = yield* response("/verify-email?token=verification-token&callbackURL=%2Finvitations%2Finvitation-1")
      expect(result.status).toBe(303)
      expect(result.headers.get("location")).toBe(
        "/api/auth/verify-email?token=verification-token&callbackURL=%2Finvitations%2Finvitation-1",
      )
    }),
  )

  it.effect("serves authenticated organization, invitation, and device pages", () =>
    Effect.gen(function* () {
      const authenticated = dependencies({ userId: "user-1", account })
      for (const path of [
        "/organizations/new",
        "/invitations/invitation-1",
        "/device",
        "/device/approve?user_code=ABCD-EFGH",
      ]) {
        const result = yield* response(path, authenticated)
        expect(result.status).toBe(200)
        expect(yield* Effect.promise(() => result.text())).toContain("<h1>")
      }
    }),
  )

  it.effect("requires an organization before device approval", () =>
    Effect.gen(function* () {
      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const page = yield* response("/device", withoutOrganization)
      const api = yield* response("/api/auth/device/approve", withoutOrganization, { method: "POST" })
      expect(page.status).toBe(303)
      expect(page.headers.get("location")).toContain("/organizations/new")
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
        resource: "https://control.example.com/api/v1",
        dpop_bound_access_tokens_required: true,
      })
    }),
  )
})
