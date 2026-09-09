import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import type { Principal } from "generalist/server"
import { handleApiV2Request } from "../src/hosted/http"
import { ProductAuthorizationError, type ProductAuthorityService } from "../src/hosted/product-authority"
import { makeProductRouteService, type ProductThreadReader } from "../src/hosted/product-routes"

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
        return Effect.succeed({ threads: [thread("visible"), thread("private"), thread("orb", "orb")], nextCursor: null })
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
