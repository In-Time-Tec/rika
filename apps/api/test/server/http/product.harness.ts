import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Redacted, Schema } from "effect"
import type { IdentityPrincipal } from "@rika/identity"
import { handleRequest, type HttpDependencies } from "../../../src/server/http"
import type { HostedEnvironmentService } from "../../../src/hosted/environment/runtime"
import { EnvironmentReferenceId } from "@rika/product/environment-policy"
import { OrganizationId } from "@rika/product/hosted-model"

import { isRikaApiPath, makeRikaApiHandler } from "../../../src/api"
import { httpFixture } from "./fixture"
const { ProjectsResponse, account, dependencies, devices, encodeJson, product } = httpFixture

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
      expect(yield* Effect.tryPromise(() => put.text())).not.toContain("environment-api-secret")
    }),
  )

  it.effect("returns the authenticated user and organization memberships", () =>
    Effect.gen(function* () {
      const result = yield* response("/api/account", dependencies({ userId: "user-1", account }))
      expect(result.status).toBe(200)
      expect(yield* Effect.tryPromise(() => result.json())).toEqual(account)
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
                owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make("organization-1") },
                name: "API",
                role: "owner",
              },
            ])
          },
        },
      })
      expect(result.status).toBe(200)
      const responseBody = yield* Effect.tryPromise(() => result.text())
      const decoded = Schema.decodeExit(Schema.fromJsonString(ProjectsResponse))(responseBody)
      const body = Exit.isSuccess(decoded) ? decoded.value : yield* Effect.die("Invalid Projects response")
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
                owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make("organization-1") },
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
      expect(yield* Effect.tryPromise(() => result.json())).toEqual({
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
      expect(yield* Effect.tryPromise(() => forwarded!.json())).toEqual({
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
            connectBrowser: () => Effect.die("unused"),
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
      expect(yield* Effect.tryPromise(() => result.json())).toEqual({
        ticket: "socket-ticket",
        expiresAt: "2026-08-19T00:01:00.000Z",
        websocketUrl: "wss://api.example.com/api/v1/threads/socket",
        protocol: "rika.thread.v1",
      })
    }),
  )

  it.effect("accepts a verified binary Workspace seed only from authenticated CLI device authority", () =>
    Effect.gen(function* () {
      const principal: IdentityPrincipal = { userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" }
      const base = dependencies({ userId: "user-1", account })
      let received: unknown
      const deps: HttpDependencies = {
        ...base,
        identity: { ...base.identity, identify: () => Effect.succeed(principal) },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
        workspaceSeeds: {
          stage: (value) => {
            received = value
            return Effect.succeed({
              id: "seed-1",
              contentDigest: `sha256:${"d".repeat(64)}`,
              sizeBytes: 3,
              expiresAt: "2026-08-19T00:10:00.000Z",
            })
          },
        },
      }
      const result = yield* response("/api/v1/workspace-seeds", deps, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.rika.workspace-seed+zstd",
          "x-rika-content-digest": `sha256:${"d".repeat(64)}`,
          "x-rika-source-repository": "In-Time-Tec/rika",
        },
        body: Uint8Array.from([1, 2, 3]),
      })
      expect(result.status).toBe(201)
      expect(received).toMatchObject({
        principal: { userId: "user-1", deviceId: "device-1", clientId: "client-1" },
        sourceRepository: { owner: "In-Time-Tec", name: "rika" },
        archive: { content: "AQID", contentDigest: `sha256:${"d".repeat(64)}`, sizeBytes: 3 },
      })
      expect(yield* Effect.tryPromise(() => result.json())).toMatchObject({ id: "seed-1", sizeBytes: 3 })

      const rejected = yield* response(
        "/api/v1/workspace-seeds",
        { ...deps, devices },
        {
          method: "POST",
          headers: {
            "content-type": "application/vnd.rika.workspace-seed+zstd",
            "x-rika-content-digest": `sha256:${"d".repeat(64)}`,
          },
          body: Uint8Array.from([1, 2, 3]),
        },
      )
      expect(rejected.status).toBe(401)
    }),
  )
})
