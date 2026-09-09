import { Effect, Option, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Server } from "generalist/server"
import type { CliDeviceDirectory, IdentityRuntime } from "@rika/identity"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import type { ProductRepositoryService } from "@rika/product-store/product-repository"
import { makeRepositoryProductAuthority } from "../src/hosted/product-authority"
import { threadPartition } from "../src/hosted/partition"

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
