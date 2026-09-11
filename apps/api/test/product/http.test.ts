import { Effect, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import type { IdentityPrincipal, IdentityRuntime } from "@rika/identity"
import { BetterAuthUserId } from "@rika/product/hosted-model"
import {
  ProductControlError,
  type ArchiveThreadInput,
  type CreateThreadInput,
  type ProductControl,
} from "../../src/product/control"
import { makeProductRequestHandler, type ProductHttpOptions } from "../../src/product/http"

const unused = () => Effect.die("Unexpected product HTTP fixture call")
const principal: IdentityPrincipal = { userId: "user", clientId: "client", dpopJkt: "public-thumbprint" }
const owner = { _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make("user") }
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const readJson = (response: Response) =>
  Effect.tryPromise(() => response.text()).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))))
const handled = (response: Response | undefined) =>
  response === undefined ? Effect.die("Expected product HTTP handler to own this route") : Effect.succeed(response)
const post = (path: string, body: Schema.Json) =>
  new Request(`https://rika.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "DPoP proof-bound-token", dpop: "request-proof" },
    body: encode(body),
  })
const archive = (path: string) =>
  new Request(`https://rika.test${path}`, {
    method: "POST",
    headers: { authorization: "DPoP proof-bound-token", dpop: "request-proof" },
  })

const fixture = (
  input: {
    readonly identify?: IdentityRuntime["identify"]
    readonly authenticate?: ProductHttpOptions["devices"]["authenticate"]
    readonly product?: Partial<ProductControl>
  } = {},
) => {
  const identified: Request[] = []
  const created: CreateThreadInput[] = []
  const archived: ArchiveThreadInput[] = []
  const registered: Parameters<ProductControl["registerRunner"]>[0][] = []
  const preferences: Parameters<ProductControl["setRemoteThreadCreation"]>[0][] = []
  const polls: Parameters<ProductControl["pollRunnerAssignment"]>[0][] = []
  const product: ProductControl = {
    identity: (actor) => Effect.succeed({ userId: actor.userId, ownerId: "owner" }),
    projects: () => Effect.succeed([{ id: "project", ownerId: "owner", owner, name: "Rika Project", role: "owner" }]),
    createProject: ({ name }) => Effect.succeed({ id: "project", ownerId: "owner", owner, name, role: "owner" }),
    createThread: (creation) =>
      Effect.sync(() => {
        created.push(creation)
        return { threadId: creation.threadId }
      }),
    archiveThread: (archiveRequest) =>
      Effect.sync(() => {
        archived.push(archiveRequest)
        return { threadId: archiveRequest.threadId, archived: true as const }
      }),
    registerRunner: (registration) =>
      Effect.sync(() => {
        registered.push(registration)
      }),
    setRemoteThreadCreation: (preference) =>
      Effect.sync(() => {
        preferences.push(preference)
      }),
    pollRunnerAssignment: (poll) =>
      Effect.sync(() => {
        polls.push(poll)
        return { claimed: true as const }
      }),
    ...input.product,
  }
  const options: ProductHttpOptions = {
    product,
    identity: {
      handle: unused,
      identify: (request) => {
        identified.push(request)
        return input.identify?.(request) ?? Effect.succeed(principal)
      },
      browserSession: unused,
      protectedResourceMetadata: Effect.succeed({}),
    },
    directory: {
      ready: Effect.void,
      account: () =>
        Effect.succeed({
          user: { id: "user", name: "Rika User", email: "rika@example.test", emailVerified: true, image: null },
          memberships: [],
        }),
    },
    devices: {
      register: unused,
      discard: unused,
      authenticate: input.authenticate ?? (() => Effect.succeed("device")),
      list: unused,
      revoke: unused,
      revokeAll: unused,
    },
  }
  return { handler: makeProductRequestHandler(options), identified, created, archived, registered, preferences, polls }
}

it.effect("serves the connected client's identity through the same current device authentication", () =>
  Effect.gen(function* () {
    const test = fixture()
    const request = new Request("https://rika.test/api/v2/identity", {
      headers: { authorization: "DPoP proof-bound-token", dpop: "request-proof" },
    })
    const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ userId: "user", ownerId: "owner", displayName: "Rika User" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(test.identified).toEqual([request])
    const revoked = fixture({
      authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)),
      product: { identity: unused },
    })
    expect((yield* revoked.handler(request).pipe(Effect.flatMap(handled))).status).toBe(401)
  }),
)

it.effect("authenticates the original DPoP request and derives personal ownership from that principal", () =>
  Effect.gen(function* () {
    const test = fixture()
    const request = post("/api/v2/threads", {
      owner: { kind: "personal" },
      threadId: "thread",
      target: "runner",
      runnerTarget: { deviceId: "device", checkoutFingerprint: "checkout" },
      projectId: "project",
      archiveThreadId: "previous",
    })
    const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
    expect(response.status).toBe(201)
    expect(yield* readJson(response)).toEqual({ threadId: "thread" })
    expect(test.identified).toEqual([request])
    expect(test.identified[0]).toBe(request)
    expect(test.created).toEqual([
      {
        actor: { userId: "user", clientId: "client", deviceId: "device", dpopJkt: "public-thumbprint" },
        owner,
        threadId: "thread",
        target: "runner",
        projectId: "project",
        archiveThreadId: "previous",
        runnerTarget: { deviceId: "device", checkoutFingerprint: "checkout" },
      },
    ])
  }),
)

it.effect("archives the exact persisted Thread route only after authenticating its DPoP request", () =>
  Effect.gen(function* () {
    const test = fixture()
    const request = archive("/api/v2/threads/thread%2Fpart/archive")
    const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ threadId: "thread/part", archived: true })
    expect(test.identified).toEqual([request])
    expect(test.archived).toEqual([
      {
        actor: { userId: "user", clientId: "client", deviceId: "device", dpopJkt: "public-thumbprint" },
        threadId: "thread/part",
      },
    ])

    const malformed = archive("/api/v2/threads/%E0%A4%A/archive")
    expect((yield* test.handler(malformed).pipe(Effect.flatMap(handled))).status).toBe(400)
    expect(test.archived).toHaveLength(1)
  }),
)

it.effect("rejects anonymous, browser-only, and unbound OAuth mutations before decoding the body", () =>
  Effect.gen(function* () {
    const cases = [
      fixture({ identify: () => Effect.void.pipe(Effect.as<IdentityPrincipal | undefined>(undefined)) }),
      fixture({
        identify: () => Effect.succeed({ userId: "user" }),
        authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)),
      }),
      fixture({ authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)) }),
    ]
    for (const test of cases) {
      const request = post("/api/v2/threads", { owner: { kind: "personal" }, threadId: "thread", target: "orb" })
      const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="rika"')
      expect(request.bodyUsed).toBe(false)
      expect(test.created).toEqual([])
    }
  }),
)

it.effect("rejects anonymous and revoked archive requests before mutation", () =>
  Effect.gen(function* () {
    const tests = [
      fixture({ identify: () => Effect.void.pipe(Effect.as<IdentityPrincipal | undefined>(undefined)) }),
      fixture({ authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)) }),
    ]
    for (const test of tests) {
      const response = yield* test.handler(archive("/api/v2/threads/thread/archive")).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(401)
      expect(test.archived).toEqual([])
    }
  }),
)

it.effect("rejects excess ownership fields and oversized product bodies without a mutation", () =>
  Effect.gen(function* () {
    const test = fixture()
    const spoofed = post("/api/v2/threads", {
      owner: { kind: "personal", userId: "someone-else" },
      threadId: "thread",
      target: "orb",
    })
    const spoofedResponse = yield* test.handler(spoofed).pipe(Effect.flatMap(handled))
    expect(spoofedResponse.status).toBe(400)
    const tooLarge = post("/api/v2/threads", {
      owner: { kind: "personal" },
      threadId: "thread",
      target: "orb",
      extra: "x".repeat(16_384),
    })
    const oversizedResponse = yield* test.handler(tooLarge).pipe(Effect.flatMap(handled))
    expect(oversizedResponse.status).toBe(413)
    expect(test.created).toEqual([])
  }),
)

it.effect("preserves account context and Project response contracts", () =>
  Effect.gen(function* () {
    const test = fixture()
    const context = yield* test
      .handler(new Request("https://rika.test/api/v1/me/context"))
      .pipe(Effect.flatMap(handled))
    expect(context.status).toBe(200)
    expect(yield* readJson(context)).toEqual({
      account: { id: "user", name: "Rika User", email: "rika@example.test" },
      organizations: [],
      projects: [
        {
          id: "project",
          ownerId: "owner",
          owner: { kind: "personal", userId: "user" },
          name: "Rika Project",
          slug: "rika-project",
        },
      ],
    })
    const created = yield* test
      .handler(post("/api/v1/projects", { owner: { kind: "personal" }, name: "New Project" }))
      .pipe(Effect.flatMap(handled))
    expect(created.status).toBe(201)
    expect(yield* readJson(created)).toEqual({
      id: "project",
      ownerId: "owner",
      owner: { kind: "personal", userId: "user" },
      name: "New Project",
      slug: "new-project",
    })
  }),
)

it.effect("binds Runner registration and remote-creation preferences to the verified device", () =>
  Effect.gen(function* () {
    const test = fixture()
    const profile = {
      protocolVersion: 2,
      workspaceIdentity: "workspace",
      repository: { identity: "repository" },
      nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.4.0", trustMode: "trusted-local" },
      capabilities: { nativeTools: true, checkpoints: false, pty: false },
    }
    const request = new Request("https://rika.test/api/v2/runners/checkout%3Afingerprint", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: encode(profile),
    })
    const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
    expect(response.status).toBe(204)
    expect(test.registered).toEqual([
      {
        actor: { userId: "user", clientId: "client", deviceId: "device", dpopJkt: "public-thumbprint" },
        checkoutFingerprint: "checkout:fingerprint",
        profile,
      },
    ])
    const preference = new Request("https://rika.test/api/v2/runners/checkout%3Afingerprint/remote-thread-creation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: encode({ preference: "allowed" }),
    })
    expect((yield* test.handler(preference).pipe(Effect.flatMap(handled))).status).toBe(204)
    expect(test.preferences[0]?.allowed).toBe(true)
    expect(test.preferences[0]?.actor.deviceId).toBe("device")
  }),
)

it.effect("polls the checkout Runner queue for the authenticated device only", () =>
  Effect.gen(function* () {
    const test = fixture()
    const request = post("/api/v2/runners/checkout%3Afingerprint/poll", {
      supervisorId: "supervisor",
      activeAssignmentIds: ["assignment-a", "assignment-b"],
    })
    const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ claimed: true, assignment: null })
    expect(test.identified).toEqual([request])
    // The queue owner comes from the authenticated device principal, never from request-controlled fields.
    expect(test.polls).toEqual([
      {
        actor: { userId: "user", clientId: "client", deviceId: "device", dpopJkt: "public-thumbprint" },
        checkoutFingerprint: "checkout:fingerprint",
        supervisorId: "supervisor",
        activeAssignmentIds: ["assignment-a", "assignment-b"],
      },
    ])
  }),
)

it.effect("passes claimed Runner assignments through the poll response", () =>
  Effect.gen(function* () {
    const assignment = {
      assignmentId: "assignment",
      threadId: "thread",
      workspaceId: "workspace",
      resume: true,
      leaseExpiresAt: 1_757_376_000_000,
    }
    const test = fixture({ product: { pollRunnerAssignment: () => Effect.succeed({ claimed: true, assignment }) } })
    const response = yield* test
      .handler(post("/api/v2/runners/checkout/poll", { supervisorId: "supervisor", activeAssignmentIds: [] }))
      .pipe(Effect.flatMap(handled))
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ claimed: true, assignment })

    const unclaimed = fixture({ product: { pollRunnerAssignment: () => Effect.succeed({ claimed: false }) } })
    const denied = yield* unclaimed
      .handler(post("/api/v2/runners/checkout/poll", { supervisorId: "supervisor", activeAssignmentIds: [] }))
      .pipe(Effect.flatMap(handled))
    expect(denied.status).toBe(200)
    expect(yield* readJson(denied)).toEqual({ claimed: false, assignment: null })
  }),
)

it.effect("requires CLI device authentication before polling a Runner queue", () =>
  Effect.gen(function* () {
    const cases = [
      fixture({ identify: () => Effect.void.pipe(Effect.as<IdentityPrincipal | undefined>(undefined)) }),
      fixture({ authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)) }),
    ]
    for (const test of cases) {
      const request = post("/api/v2/runners/checkout/poll", {
        supervisorId: "supervisor",
        activeAssignmentIds: [],
      })
      const response = yield* test.handler(request).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="rika"')
      expect(request.bodyUsed).toBe(false)
      expect(test.polls).toEqual([])
    }
  }),
)

it.effect("rejects malformed and spoofed Runner poll bodies without polling", () =>
  Effect.gen(function* () {
    const test = fixture()
    const bodies: ReadonlyArray<Schema.Json> = [
      {},
      { supervisorId: "supervisor" },
      { supervisorId: "", activeAssignmentIds: [] },
      { supervisorId: "supervisor", activeAssignmentIds: [""] },
      { supervisorId: "supervisor", activeAssignmentIds: Array.from({ length: 65 }, (_, index) => `id-${index}`) },
      { supervisorId: "s".repeat(257), activeAssignmentIds: [] },
      // Spoofed actor fields are excess properties and must not redirect another device's queue.
      { supervisorId: "supervisor", activeAssignmentIds: [], deviceId: "other-device", userId: "other-user" },
    ]
    for (const body of bodies) {
      const response = yield* test.handler(post("/api/v2/runners/checkout/poll", body)).pipe(Effect.flatMap(handled))
      expect(response.status).toBe(400)
    }
    const fingerprint = yield* test
      .handler(post("/api/v2/runners/%20/poll", { supervisorId: "supervisor", activeAssignmentIds: [] }))
      .pipe(Effect.flatMap(handled))
    expect(fingerprint.status).toBe(400)
    expect(test.polls).toEqual([])
  }),
)

it.effect("keeps PUT runner routes unchanged and rejects poll lookup on other methods", () =>
  Effect.gen(function* () {
    const test = fixture()
    // The poll route is POST-only; other verbs and suffixes remain unhandled by the product handler.
    for (const [method, path] of [
      ["PUT", "/api/v2/runners/checkout/poll"],
      ["POST", "/api/v2/runners/checkout"],
      ["POST", "/api/v2/runners/checkout/remote-thread-creation"],
      ["DELETE", "/api/v2/runners/checkout/poll"],
    ] as const) {
      const request = new Request(`https://rika.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: "DPoP proof-bound-token", dpop: "request-proof" },
        body: encode({ supervisorId: "supervisor", activeAssignmentIds: [] }),
      })
      expect(yield* test.handler(request)).toBeUndefined()
    }
    const unavailable = fixture({
      product: {
        pollRunnerAssignment: () => ProductControlError.make({ kind: "unavailable", message: "store is down" }),
      },
    })
    const response = yield* unavailable
      .handler(post("/api/v2/runners/checkout/poll", { supervisorId: "supervisor", activeAssignmentIds: [] }))
      .pipe(Effect.flatMap(handled))
    expect(response.status).toBe(503)
  }),
)

it.effect("maps product rejections and leaves identity, metadata reads, and Runtime routes to their owners", () =>
  Effect.gen(function* () {
    for (const [kind, status] of [
      ["invalid", 400],
      ["forbidden", 403],
      ["not-found", 404],
      ["conflict", 409],
      ["unavailable", 503],
    ] as const) {
      const test = fixture({ product: { createThread: () => ProductControlError.make({ kind, message: "Rejected" }) } })
      const response = yield* test
        .handler(
          post("/api/v2/threads", {
            owner: { kind: "organization", organization_id: "organization" },
            threadId: "thread",
            target: "orb",
          }),
        )
        .pipe(Effect.flatMap(handled))
      expect(response.status).toBe(status)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    const test = fixture()
    for (const path of ["/api/account", "/api/auth/token", "/api/v2/threads", "/api/v2/threads/thread/runtime/runs"])
      expect(yield* test.handler(new Request(`https://rika.test${path}`))).toBeUndefined()
    expect(test.identified).toEqual([])
  }),
)
