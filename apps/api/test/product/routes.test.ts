/* oxlint-disable max-lines -- catalog scope, authorization filtering, and cursor stability stay mirrored in one suite. */
import "./repository-routes.harness"
import { Crypto, Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import type { Principal } from "generalist/server"
import { OrganizationId } from "@rika/product/hosted-model"
import {
  ProductRepositoryError,
  type OwnerAuthority,
  type ProductRepositoryService,
} from "@rika/product-store/product-repository"
import { handleApiV2Request } from "../../src/transport/http"
import { ProductAuthorizationError, type ProductAuthorityService } from "../../src/product/authority"
import { makeProductRouteService, type ProductThreadReader } from "../../src/product/routes"

const principal: Principal = { id: "client", tenantId: "owner", role: "controller" }
const none = <A>(): Effect.Effect<A | undefined, never> => Effect.as(Effect.void, undefined)
const unused = () => Effect.die("unused")

const thread = (id: string, target: "runner" | "orb" = "runner") => ({
  id,
  title: `Thread ${id}`,
  target,
  sessionId: `rika-v2:owner:${id}`,
  updatedAt: "2026-09-09T00:00:00.000Z",
})

const gateway = {
  ensureRootSession: () => Effect.succeed({ sessionId: "unused", created: false }),
  handle: () => Effect.succeed(new Response("unused")),
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, bytes) => Effect.succeed(bytes),
})

const organizationAuthority: OwnerAuthority = {
  ownerId: "organization-owner",
  owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make("organization") },
  userId: "user",
  membershipId: "member",
}

const scopedOwners = (resolveOwner: ProductRepositoryService["resolveOwner"]) => ({
  product: { resolveOwner },
  crypto: testCrypto,
  userId: (scoped: Principal) => (scoped.id === principal.id ? "user" : undefined),
})

const request = (path: string, init?: RequestInit) =>
  new Request(`https://rika.test${path}`, {
    headers: { authorization: "Bearer valid" },
    ...init,
  })

const readJson = (response: Response) => Effect.tryPromise(() => response.json())

it.effect("filters inaccessible Threads with the current product authorization", () =>
  Effect.gen(function* () {
    const authorized: string[] = []
    const authority: ProductAuthorityService = {
      authenticateBearer: (_token, context) => {
        expect(context?.threadId).toBeUndefined()
        expect(context?.request?.url).toBe("https://rika.test/api/v2/threads")
        return Effect.succeed(principal)
      },
      threadBinding: unused,
      resourceThread: unused,
      authorize: ({ threadId }) => {
        if (threadId !== undefined) authorized.push(threadId)
        return Effect.succeed(threadId !== "private")
      },
    }
    const reader: ProductThreadReader = {
      list: (input) => {
        expect(input).toEqual({ ownerId: "owner", limit: 50 })
        return Effect.succeed({
          threads: [thread("visible"), thread("private"), thread("orb", "orb")],
          nextCursor: null,
        })
      },
      get: unused,
    }
    const product = makeProductRouteService({ authority, reader })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads"),
    })
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ threads: [thread("visible"), thread("orb", "orb")], nextCursor: null })
    expect(authorized).toEqual(["visible", "private", "orb"])
  }),
)

it.effect("does not disclose an unauthorized Thread detail", () =>
  Effect.gen(function* () {
    let authorizations = 0
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => {
        authorizations += 1
        return Effect.succeed(false)
      },
    }
    const reader: ProductThreadReader = {
      list: () => Effect.succeed({ threads: [], nextCursor: null }),
      get: (input) => Effect.succeed({ ...thread(input.threadId), title: "Private" }),
    }
    const product = makeProductRouteService({ authority, reader })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads/private"),
    })
    expect(response.status).toBe(404)
    expect(yield* readJson(response)).toEqual({ message: "Thread is unavailable" })
    expect(authorizations).toBe(1)
  }),
)

it.effect("rejects unauthenticated product reads before consulting metadata", () =>
  Effect.gen(function* () {
    let reads = 0
    const authority: ProductAuthorityService = {
      authenticateBearer: () => none<Principal>(),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    const product = makeProductRouteService({
      authority,
      reader: {
        list: () => {
          reads += 1
          return Effect.succeed({ threads: [], nextCursor: null })
        },
        get: unused,
      },
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: new Request("https://rika.test/api/v2/threads"),
    })
    expect(response.status).toBe(401)
    expect(reads).toBe(0)
  }),
)

it.effect("bounds product list pages before consulting metadata", () =>
  Effect.gen(function* () {
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    let requested: number | undefined
    const product = makeProductRouteService({
      authority,
      reader: {
        list: (input) => {
          requested = input.limit
          return Effect.succeed({ threads: [], nextCursor: null })
        },
        get: unused,
      },
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?limit=101"),
    })
    expect(response.status).toBe(400)
    expect(requested).toBeUndefined()
  }),
)

it.effect("surfaces authorization service failures instead of treating every Thread as hidden", () =>
  Effect.gen(function* () {
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () =>
        Effect.fail(ProductAuthorizationError.make({ kind: "unavailable", message: "authority unavailable" })),
    }
    const product = makeProductRouteService({
      authority,
      reader: {
        list: () => Effect.succeed({ threads: [thread("visible")], nextCursor: null }),
        get: unused,
      },
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads"),
    })
    expect(response.status).toBe(503)
  }),
)

it.effect("continues across denied metadata pages without returning an empty authorized page", () =>
  Effect.gen(function* () {
    const cursors: Array<string | undefined> = []
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: ({ threadId }) => Effect.succeed(threadId !== "private"),
    }
    const product = makeProductRouteService({
      authority,
      reader: {
        list: (input) => {
          cursors.push(input.cursor)
          return input.cursor === undefined
            ? Effect.succeed({ threads: [thread("private")], nextCursor: "page-2" })
            : Effect.succeed({ threads: [thread("visible")], nextCursor: null })
        },
        get: unused,
      },
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?limit=1"),
    })
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ threads: [thread("visible")], nextCursor: null })
    expect(cursors).toEqual([undefined, "page-2"])
  }),
)

it.effect("preserves every authorized Thread when filling a partially filtered page", () =>
  Effect.gen(function* () {
    const source = [thread("first"), thread("private"), thread("second"), thread("third")]
    const requests: Array<{ offset: number; limit: number }> = []
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: ({ threadId }) => Effect.succeed(threadId !== "private"),
    }
    const product = makeProductRouteService({
      authority,
      reader: {
        list: (input) => {
          const offset = Number(input.cursor ?? "0")
          const end = offset + input.limit
          requests.push({ offset, limit: input.limit })
          return Effect.succeed({
            threads: source.slice(offset, end),
            nextCursor: end < source.length ? String(end) : null,
          })
        },
        get: unused,
      },
    })
    const first = yield* product.listThreads({ principal, limit: 2 })
    expect(first).toEqual({ threads: [thread("first"), thread("second")], nextCursor: "3" })
    const second = yield* product.listThreads({ principal, limit: 2, cursor: "3" })
    expect(second).toEqual({ threads: [thread("third")], nextCursor: null })
    expect(requests).toEqual([
      { offset: 0, limit: 2 },
      { offset: 2, limit: 1 },
      { offset: 3, limit: 2 },
    ])
  }),
)

it.effect("lists Threads under a caller-selected organization owner", () =>
  Effect.gen(function* () {
    const resolved: Array<Parameters<ProductRepositoryService["resolveOwner"]>[0]> = []
    const tenants: string[] = []
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: (input) => {
        tenants.push(input.principal.tenantId)
        return Effect.succeed(true)
      },
    }
    const reader: ProductThreadReader = {
      list: (input) => {
        expect(input).toEqual({ ownerId: "organization-owner", limit: 50 })
        return Effect.succeed({ threads: [thread("org-thread")], nextCursor: null })
      },
      get: unused,
    }
    const product = makeProductRouteService({
      authority,
      reader,
      owners: scopedOwners((input) =>
        Effect.sync(() => {
          resolved.push(input)
          return organizationAuthority
        }),
      ),
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?owner=organization:organization"),
    })
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual({ threads: [thread("org-thread")], nextCursor: null })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.userId).toBe("user")
    expect(resolved[0]?.selection).toEqual({
      _tag: "OrganizationOwner",
      organizationId: "organization",
    })
    // Per-Thread grant checks run against the scoped organization owner, not the personal tenant.
    expect(tenants).toEqual(["organization-owner"])
  }),
)

it.effect("applies the organization scope to a single Thread read", () =>
  Effect.gen(function* () {
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    const reader: ProductThreadReader = {
      list: unused,
      get: (input) => {
        expect(input).toEqual({ ownerId: "organization-owner", threadId: "org-thread" })
        return Effect.succeed(thread("org-thread"))
      },
    }
    const product = makeProductRouteService({
      authority,
      reader,
      owners: scopedOwners(() => Effect.succeed(organizationAuthority)),
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads/org-thread?owner=organization:organization"),
    })
    expect(response.status).toBe(200)
    expect(yield* readJson(response)).toEqual(thread("org-thread"))
  }),
)

it.effect("rejects organization scopes the authenticated member cannot see", () =>
  Effect.gen(function* () {
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    const reader: ProductThreadReader = {
      list: () => Effect.die("metadata must not be read for an invisible owner"),
      get: unused,
    }
    const denied = makeProductRouteService({
      authority,
      reader,
      owners: scopedOwners(() =>
        ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" }),
      ),
    })
    const deniedResponse = yield* handleApiV2Request({
      authority,
      product: denied,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?owner=organization:other"),
    })
    expect(deniedResponse.status).toBe(403)

    const unaffiliated = makeProductRouteService({
      authority,
      reader,
      owners: scopedOwners(() =>
        Effect.succeed({
          ownerId: "organization-owner",
          owner: { _tag: "OrganizationOwner" as const, organizationId: OrganizationId.make("organization") },
          userId: "user",
        }),
      ),
    })
    const unaffiliatedResponse = yield* handleApiV2Request({
      authority,
      product: unaffiliated,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?owner=organization:organization"),
    })
    expect(unaffiliatedResponse.status).toBe(403)

    // Without owner-scope support the service fails closed instead of reading under the personal owner.
    const unsupported = makeProductRouteService({ authority, reader })
    const unsupportedResponse = yield* handleApiV2Request({
      authority,
      product: unsupported,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?owner=organization:organization"),
    })
    expect(unsupportedResponse.status).toBe(403)
  }),
)

it.effect("keeps the personal tenant for absent or personal owner selections", () =>
  Effect.gen(function* () {
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    const owners: Parameters<typeof makeProductRouteService>[0]["owners"] = {
      product: { resolveOwner: () => Effect.die("personal listings must not resolve an organization owner") },
      crypto: testCrypto,
      userId: () => undefined,
    }
    for (const path of ["/api/v2/threads", "/api/v2/threads?owner=personal"]) {
      const product = makeProductRouteService({
        authority,
        reader: {
          list: (input) => {
            expect(input).toEqual({ ownerId: "owner", limit: 50 })
            return Effect.succeed({ threads: [thread("visible")], nextCursor: null })
          },
          get: unused,
        },
        owners,
      })
      const response = yield* handleApiV2Request({
        authority,
        product,
        gateway,
        environment: "test",
        request: request(path),
      })
      expect(response.status).toBe(200)
      expect(yield* readJson(response)).toEqual({ threads: [thread("visible")], nextCursor: null })
    }
  }),
)

it.effect("rejects malformed catalog scopes before reading metadata", () =>
  Effect.gen(function* () {
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    let reads = 0
    const product = makeProductRouteService({
      authority,
      reader: {
        list: () => {
          reads += 1
          return Effect.succeed({ threads: [], nextCursor: null })
        },
        get: unused,
      },
      owners: scopedOwners(() => Effect.succeed(organizationAuthority)),
    })
    for (const path of [
      "/api/v2/threads?owner=everything",
      "/api/v2/threads?owner=organization:",
      "/api/v2/threads?owner=organization:not%20an%20id",
      "/api/v2/threads?project_id=",
    ]) {
      const response = yield* handleApiV2Request({
        authority,
        product,
        gateway,
        environment: "test",
        request: request(path),
      })
      expect(response.status).toBe(400)
    }
    expect(reads).toBe(0)
  }),
)

it.effect("scopes a catalog page by Project while preserving cursors", () =>
  Effect.gen(function* () {
    const requests: Array<{ ownerId: string; projectId?: string; cursor?: string; limit: number }> = []
    const authority: ProductAuthorityService = {
      authenticateBearer: () => Effect.succeed(principal),
      threadBinding: unused,
      resourceThread: unused,
      authorize: () => Effect.succeed(true),
    }
    const product = makeProductRouteService({
      authority,
      reader: {
        list: (input) => {
          requests.push(input)
          return Effect.succeed({ threads: [thread("scoped")], nextCursor: null })
        },
        get: unused,
      },
    })
    const response = yield* handleApiV2Request({
      authority,
      product,
      gateway,
      environment: "test",
      request: request("/api/v2/threads?project_id=project-x&cursor=page-1&limit=10"),
    })
    expect(response.status).toBe(200)
    expect(requests).toEqual([{ ownerId: "owner", projectId: "project-x", cursor: "page-1", limit: 10 }])
    expect(yield* readJson(response)).toEqual({ threads: [thread("scoped")], nextCursor: null })
  }),
)
