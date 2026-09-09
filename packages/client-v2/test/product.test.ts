import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeProductClient, makeFetchTransport } from "../src/product"

it.effect("ensures a Thread Session through the product route and only its durable command header", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: makeFetchTransport((request) => {
      seen.push(request)
      // ast-grep-ignore: effect-prefer-promise-composition -- the fixture returns a Web Response from a foreign Fetch stub.
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "rika-v2:owner:thread", created: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
    }),
    bearerToken: "test-token",
  })
  return client.ensureSession("thread", "command-1").pipe(
    Effect.tap((receipt) =>
      Effect.sync(() => {
        expect(receipt).toEqual({ sessionId: "rika-v2:owner:thread", created: true })
        expect(seen).toHaveLength(1)
        expect(seen[0]?.url).toBe("https://rika.test/api/v2/threads/thread/session")
        expect(seen[0]?.headers.get("authorization")).toBe("Bearer test-token")
        expect(seen[0]?.headers.get("x-command-id")).toBe("command-1")
        expect(seen[0]?.headers.get("content-type")).toBeNull()
      }),
    ),
  )
})

it.effect("pages product Threads without leaking the bearer token into query state", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test/",
    transport: makeFetchTransport((request) => {
      seen.push(request)
      // ast-grep-ignore: effect-prefer-promise-composition -- the fixture returns a Web Response from a foreign Fetch stub.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            threads: [{ id: "thread", title: "Hosted", target: "runner" }],
            nextCursor: "cursor-2",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    }),
  })
  return client.listThreads({ cursor: "cursor-1", limit: 25 }).pipe(
    Effect.tap((page) =>
      Effect.sync(() => {
        expect(page.nextCursor).toBe("cursor-2")
        expect(seen[0]?.url).toBe("https://rika.test/api/v2/threads?cursor=cursor-1&limit=25")
        expect(seen[0]?.headers.get("authorization")).toBeNull()
      }),
    ),
  )
})

it.effect("uses the owning credential service for per-request authorization headers", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: makeFetchTransport((request) => {
      seen.push(request)
      // ast-grep-ignore: effect-prefer-promise-composition -- the fixture returns a Web Response from a foreign Fetch stub.
      return Promise.resolve(
        new Response(JSON.stringify({ userId: "user", ownerId: "owner" }), {
          headers: { "content-type": "application/json" },
        }),
      )
    }),
    requestHeaders: ({ method, url }) =>
      Effect.succeed({
        authorization: `DPoP access-${method}`,
        dpop: `proof-for-${url}`,
      }),
  })
  return client.identity.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(seen[0]?.headers.get("authorization")).toBe("DPoP access-GET")
        expect(seen[0]?.headers.get("dpop")).toBe("proof-for-https://rika.test/api/v2/identity")
      }),
    ),
  )
})
