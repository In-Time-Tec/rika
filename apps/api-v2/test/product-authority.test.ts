import { Effect, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Server } from "generalist/server"
import type { CliDeviceDirectory, IdentityRuntime } from "@rika/identity"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import type { ProductRepositoryService } from "@rika/product-store/product-repository"
import { makeRepositoryProductAuthority } from "../src/hosted/product-authority"
import { decodeWorkspaceBinding, threadPartition } from "../src/hosted/partition"

const identity: IdentityRuntime = {
  handle: () => Effect.succeed(new Response("ok")),
  identify: () => Effect.succeed({ userId: "user", clientId: "client", dpopJkt: "jkt" }),
  browserSession: () => Effect.succeed(Option.none<never>()).pipe(Effect.map(Option.getOrUndefined)),
  protectedResourceMetadata: Effect.succeed({}),
}

const unused = () => Effect.die("unused test seam")

const devices: CliDeviceDirectory = {
  register: unused,
  discard: unused,
  authenticate: () => Effect.succeed("device"),
  list: unused,
  revoke: unused,
  revokeAll: unused,
}

const authorityProjection = {
  ownerId: "owner",
  kind: "personal",
  userId: "user",
  organizationId: null,
  membershipId: null,
  createdByUserId: "user",
  executorKind: "runner",
  inheritProjectGrants: false,
  threadRole: null,
  projectRole: null,
} as const

const canonicalBinding = {
  partition: threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" }),
  placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
  workspaceBinding: decodeWorkspaceBinding({
    workspaceId: "workspace",
    assignmentId: "assignment",
    generation: 1,
    placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
    buildId: "build",
    protocolVersion: 1,
  }),
} as const

const product: ProductRepositoryService = {
  stageWorkspaceSeed: unused,
  resolveOwner: unused,
  organizationIds: unused,
  projects: unused,
  projectAccess: unused,
  createProject: unused,
  existingConnection: unused,
  createConnection: unused,
  threadAuthority: () => Effect.succeed(authorityProjection),
  threadAuthorities: unused,
  personalOwnerId: () => Effect.succeed("owner"),
  threadMetadataList: unused,
  threadMetadata: unused,
  threadExecutionContext: unused,
  ready: unused(),
}

const clientAuthority = (
  authorizeThread: HostedClientAuthorityService["authorizeThread"],
): HostedClientAuthorityService => ({
  registerDevice: unused,
  authenticateClient: unused,
  grantClientAuthority: unused,
  findThread: unused,
  readThread: unused,
  authorizeThread,
})

it.effect("adapts the released identity/device/product authorities to Generalist policy", () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const authority = makeRepositoryProductAuthority({
      identity,
      devices,
      product,
      clientAuthority: clientAuthority(() => {
        calls.push("authorize")
        return Effect.void
      }),
      environment: "test",
      binding: () => Effect.succeed(canonicalBinding),
    })

    const principal = yield* authority.authenticateBearer("token", { threadId: "thread" })
    expect(principal).toEqual({
      id: "rika-client:user:owner:client:device",
      tenantId: "owner",
      role: "controller",
    })
    const binding = yield* authority.threadBinding("thread", "owner")
    expect(binding?.partition.rootSessionId).toBe("rika-v2:owner:thread")
    expect(binding?.placement).toEqual({ _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" })
    const decodedPrincipal = yield* Schema.decodeEffect(Server.Principal)(principal!)
    const allowed = yield* authority.authorize({
      principal: decodedPrincipal,
      resource: { type: "session", id: binding!.partition.rootSessionId },
      action: "mutate",
    })
    expect(allowed).toBe(true)
    expect(calls).toEqual(["authorize"])
  }),
)

it.effect("authenticates an owner-level product request before a Thread is selected", () =>
  Effect.gen(function* () {
    const authority = makeRepositoryProductAuthority({
      identity,
      devices,
      product,
      clientAuthority: clientAuthority(() => Effect.void),
      environment: "test",
      binding: () => Effect.succeed(canonicalBinding),
    })
    const principal = yield* authority.authenticateBearer("token", {
      request: new Request("https://rika.test/api/v2/threads"),
    })
    expect(principal).toMatchObject({ tenantId: "owner", role: "controller" })
  })
)

it.effect("issues a scoped downstream credential after DPoP edge authentication", () =>
  Effect.gen(function* () {
    let authenticatedRequest:
      | {
          readonly method: string
          readonly url: string
          readonly authorization: string | null
          readonly dpop: string | null
        }
      | undefined
    const authority = makeRepositoryProductAuthority({
      identity: {
        ...identity,
        identify: (request) =>
          Effect.sync(() => {
            authenticatedRequest = {
              method: request.method,
              url: request.url,
              authorization: request.headers.get("authorization"),
              dpop: request.headers.get("dpop"),
            }
            return { userId: "user", clientId: "client", dpopJkt: "jkt" }
          }),
      },
      devices,
      product,
      clientAuthority: clientAuthority(() => Effect.void),
      environment: "test",
      binding: () => Effect.succeed(canonicalBinding),
    })
    const request = new Request("https://rika.test/api/v2/threads/thread/runtime/runs/run-1?cursor=abc", {
      method: "POST",
      headers: { authorization: "DPoP access-token", dpop: "proof" },
      body: "prompt",
    })
    const principal = yield* authority.authenticateBearer("access-token", {
      ownerId: "owner",
      threadId: "thread",
      request,
    })
    expect(principal).toBeDefined()
    expect(authenticatedRequest?.method).toBe("POST")
    expect(authenticatedRequest?.url).toBe("https://rika.test/api/v2/threads/thread/runtime/runs/run-1?cursor=abc")
    expect(authenticatedRequest?.authorization).toBe("DPoP access-token")
    expect(authenticatedRequest?.dpop).toBe("proof")
    const forwardedRequest = new Request("https://rivet.local/sessions/root", {
      method: "GET",
      headers: {
        "x-rika-original-request-url": request.url,
        "x-rika-original-request-method": request.method,
      },
    })
    const downstreamCredential = yield* authority.downstreamCredential!({
      principal: principal!,
      ownerId: "owner",
      threadId: "thread",
      request,
    })
    expect(downstreamCredential).toMatch(/^rika-ds-/)
    const downstream = yield* authority.authenticateDownstream!(downstreamCredential!, {
      ownerId: "owner",
      threadId: "thread",
      request: forwardedRequest,
    })
    expect(downstream).toEqual(principal)
    expect(
      yield* authority.authenticateDownstream!(downstreamCredential!, {
        ownerId: "owner",
        threadId: "other",
        request: forwardedRequest,
      }),
    ).toBeUndefined()
    for (let index = 0; index < 3; index++)
      expect(
        yield* authority.authenticateDownstream!(downstreamCredential!, {
          ownerId: "owner",
          threadId: "thread",
          request: forwardedRequest,
        }),
      ).toEqual(principal)
    expect(
      yield* authority.authenticateDownstream!(downstreamCredential!, {
        ownerId: "owner",
        threadId: "thread",
        request: forwardedRequest,
      }),
    ).toBeUndefined()
    const expired = yield* authority.downstreamCredential!({
      principal: principal!,
      ownerId: "owner",
      threadId: "thread",
      request,
    })
    yield* TestClock.adjust("11 seconds")
    expect(
      yield* authority.authenticateDownstream!(expired!, {
        ownerId: "owner",
        threadId: "thread",
        request: forwardedRequest,
      }),
    ).toBeUndefined()
  }),
)

it.effect("rejects a token whose active CLI device was revoked", () =>
  Effect.gen(function* () {
    const revokedDevices = {
      ...devices,
      authenticate: () => Effect.succeed(Option.none<string>()).pipe(Effect.map(Option.getOrUndefined)),
    }
    const authority = makeRepositoryProductAuthority({
      identity,
      devices: revokedDevices,
      product,
      clientAuthority: clientAuthority(() => Effect.void),
      environment: "test",
      binding: () => Effect.succeed(canonicalBinding),
    })
    const principal = yield* authority.authenticateBearer("token", { threadId: "thread" })
    expect(principal).toBeUndefined()
  }),
)

it.effect("denies a revoked hosted client before Generalist resource admission", () =>
  Effect.gen(function* () {
    const authority = makeRepositoryProductAuthority({
      identity,
      devices,
      product,
      clientAuthority: clientAuthority(() =>
        Effect.fail(HostedPersistenceError.make({ reason: "invalid-authority", message: "revoked" })),
      ),
      environment: "test",
      binding: () => Effect.succeed(canonicalBinding),
    })
    const principal = yield* authority.authenticateBearer("token", { threadId: "thread" })
    const allowed = yield* authority.authorize({
      principal: principal!,
      resource: { type: "session", id: "rika-v2:owner:thread" },
      action: "mutate",
    })
    expect(allowed).toBe(false)
  }),
)

it.effect("authorizes opaque Runs and artifacts only in the explicit canonical Thread partition", () =>
  Effect.gen(function* () {
    let revoked = false
    const authority = makeRepositoryProductAuthority({
      identity,
      devices,
      product: {
        ...product,
        threadAuthority: (_userId, threadId) =>
          Effect.succeed(
            threadId === "foreign"
              ? { ...authorityProjection, ownerId: "other" }
              : { ...authorityProjection, ownerId: "owner" },
          ),
      },
      clientAuthority: clientAuthority((input) =>
        !revoked && String(input.threadId) === "thread"
          ? Effect.void
          : Effect.fail(HostedPersistenceError.make({ reason: "invalid-authority", message: "denied" })),
      ),
      environment: "test",
      binding: ({ ownerId, threadId }) =>
        Effect.succeed({
          ...canonicalBinding,
          partition: threadPartition({ environment: "test", ownerId, threadId, target: "runner" }),
        }),
    })
    const principal = yield* authority.authenticateBearer("token", { threadId: "thread" })
    expect(principal).toBeDefined()
    const run = { type: "run" as const, id: "opaque-run" }
    const artifact = { type: "artifact" as const, id: "artifact-name" }
    expect(
      yield* authority.authorize({ principal: principal!, resource: run, action: "observe", threadId: "thread" }),
    ).toBe(true)
    expect(
      yield* authority.authorize({ principal: principal!, resource: artifact, action: "observe", threadId: "other" }),
    ).toBe(false)
    expect(
      yield* authority.authorize({ principal: principal!, resource: run, action: "observe", threadId: "foreign" }),
    ).toBe(false)
    revoked = true
    expect(
      yield* authority.authorize({ principal: principal!, resource: run, action: "observe", threadId: "thread" }),
    ).toBe(false)
  }),
)
