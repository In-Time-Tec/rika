import type { WorkspaceSeedStageRequestEncoded } from "@rika/workspace-input/workspace-seed-http-contract"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ProductClientError } from "../src/product"
import { makeWorkspaceSeedClient } from "../src/workspace-seeds"

const digest = `sha256:${"a".repeat(64)}` as const
const input = {
  owner: { kind: "organization", organization_id: "organization" },
  projectId: "project",
  archive: { content: "AQ==", contentDigest: digest, sizeBytes: 1 },
} satisfies WorkspaceSeedStageRequestEncoded

it.effect("serializes the strict request and authenticates the exact POST URL with fresh DPoP", () => {
  const requests: Request[] = []
  let authorizations = 0
  const client = makeWorkspaceSeedClient({
    baseUrl: "https://rika.test/product",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return Response.json({ workspaceSeedId: "workspace-seed" }, { status: 201 })
        }),
    },
    requestHeaders: ({ method, url }) =>
      Effect.sync(() => {
        authorizations += 1
        return { authorization: `DPoP access-${authorizations}`, dpop: `proof-${method}-${url}` }
      }),
  })
  return Effect.gen(function* () {
    expect(yield* client.stage(input)).toEqual({ workspaceSeedId: "workspace-seed" })
    expect(yield* client.stage(input)).toEqual({ workspaceSeedId: "workspace-seed" })
    expect(authorizations).toBe(2)
    for (const [index, request] of requests.entries()) {
      expect(request.method).toBe("POST")
      expect(request.url).toBe("https://rika.test/product/api/v2/workspace-seeds")
      expect(request.headers.get("authorization")).toBe(`DPoP access-${index + 1}`)
      expect(request.headers.get("dpop")).toBe("proof-POST-https://rika.test/product/api/v2/workspace-seeds")
      expect(request.headers.get("content-type")).toBe("application/json")
      expect(yield* Effect.tryPromise(() => request.json())).toEqual(input)
    }
  })
})

it.effect("is lazy and rejects invalid input or base URLs before authorization and transport", () => {
  let authorizations = 0
  let requests = 0
  const make = (baseUrl: string) =>
    makeWorkspaceSeedClient({
      baseUrl,
      transport: {
        request: () =>
          Effect.sync(() => {
            requests += 1
            return new Response(null, { status: 201 })
          }),
      },
      requestHeaders: () =>
        Effect.sync(() => {
          authorizations += 1
          return {}
        }),
    })
  const client = make("https://rika.test")
  expect(authorizations).toBe(0)
  expect(requests).toBe(0)
  const invalid = { ...input, unexpected: true }
  const invalidArchive = { ...input, archive: { ...input.archive, sizeBytes: 0 } }
  return Effect.gen(function* () {
    for (const value of [invalid, invalidArchive]) {
      const result = yield* Effect.result(client.stage(value))
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "protocol" } })
    }
    for (const baseUrl of [
      "ftp://rika.test",
      "https://user:password@rika.test",
      "https://rika.test?query=value",
      "https://rika.test#fragment",
    ]) {
      const result = yield* Effect.result(make(baseUrl).stage(input))
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "protocol" } })
    }
    expect(authorizations).toBe(0)
    expect(requests).toBe(0)
  })
})

it.effect("maps transport, authorization, and malformed receipts without exposing the archive", () => {
  const make = (request: () => Effect.Effect<Response, ProductClientError>) =>
    makeWorkspaceSeedClient({
      baseUrl: "https://rika.test",
      transport: { request },
      requestHeaders: () => Effect.succeed({}),
    })
  const cases = [
    make(() => Effect.fail(ProductClientError.make({ kind: "protocol", message: input.archive.content }))),
    make(() => Effect.succeed(new Response(null, { status: 401 }))),
    make(() => Effect.succeed(new Response(null, { status: 403 }))),
    make(() => Effect.succeed(new Response("{", { status: 201 }))),
    make(() => Effect.succeed(Response.json({ workspaceSeedId: "" }, { status: 201 }))),
  ]
  return Effect.gen(function* () {
    const expected = ["network", "unauthorized", "forbidden", "protocol", "protocol"]
    for (const [index, client] of cases.entries()) {
      const result = yield* Effect.result(client.stage(input))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.kind).toBe(expected[index])
        expect(result.failure.message).not.toContain(input.archive.content)
      }
    }
  })
})
