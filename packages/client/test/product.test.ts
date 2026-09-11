import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  ThreadArchiveReceipt,
  ThreadCreationReceipt,
  type ThreadCreateRequestEncoded,
} from "@rika/product/thread-creation"
import { makeProductClient, makeFetchTransport, ProductClientError } from "../src/product"

const runnerThread = (threadId = "runner-thread") =>
  ({
    owner: { kind: "personal" },
    threadId,
    target: "runner",
    runnerTarget: { deviceId: "runner-device", checkoutFingerprint: "checkout" },
  }) satisfies ThreadCreateRequestEncoded

const readJson = (request: Request) => Effect.tryPromise(() => request.json())
const creationResponse = (threadId: string) =>
  new Response(Schema.encodeSync(Schema.fromJsonString(ThreadCreationReceipt))({ threadId }), {
    status: 201,
    headers: { "content-type": "application/json" },
  })
const archiveResponse = (threadId: string) =>
  new Response(Schema.encodeSync(Schema.fromJsonString(ThreadArchiveReceipt))({ threadId, archived: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

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
        expect(seen[0]?.url).toBe("https://rika.test/api/v2/threads?cursor=cursor-1&limit=25&owner=personal")
        expect(seen[0]?.headers.get("authorization")).toBeNull()
      }),
    ),
  )
})

it.effect("scopes product Thread paging to the selected organization owner and project", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test/",
    transport: makeFetchTransport((request) => {
      seen.push(request)
      // ast-grep-ignore: effect-prefer-promise-composition -- the fixture returns a Web Response from a foreign Fetch stub.
      return Promise.resolve(
        new Response(JSON.stringify({ threads: [], nextCursor: null }), {
          headers: { "content-type": "application/json" },
        }),
      )
    }),
  })
  return client
    .listThreads({
      limit: 10,
      scope: { owner: { kind: "organization", organization_id: "organization-1" }, projectId: "project-1" },
    })
    .pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(seen[0]?.url).toBe(
            "https://rika.test/api/v2/threads?limit=10&owner=organization%3Aorganization-1&project_id=project-1",
          )
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

it.effect("creates a Runner Thread with the exact personal request body", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return creationResponse("runner-thread")
        }),
    },
    requestHeaders: ({ method, url }) => Effect.succeed({ authorization: `DPoP ${method}`, dpop: `proof-${url}` }),
  })
  return Effect.gen(function* () {
    expect(yield* client.createThread(runnerThread())).toEqual({ threadId: "runner-thread" })
    const request = seen[0]
    if (request === undefined) return yield* Effect.die("Thread creation request was not sent")
    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://rika.test/api/v2/threads")
    expect(request.headers.get("content-type")).toBe("application/json")
    expect(request.headers.get("authorization")).toBe("DPoP POST")
    expect(request.headers.get("dpop")).toBe("proof-https://rika.test/api/v2/threads")
    expect(yield* readJson(request)).toEqual({
      owner: { kind: "personal" },
      threadId: "runner-thread",
      target: "runner",
      runnerTarget: { deviceId: "runner-device", checkoutFingerprint: "checkout" },
    })
  })
})

it.effect("creates an organization-owned Runner Thread with the wire owner selection", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return creationResponse("organization-thread")
        }),
    },
  })
  const input = {
    owner: { kind: "organization", organization_id: "organization" },
    threadId: "organization-thread",
    target: "runner",
    runnerTarget: { deviceId: "runner-device", checkoutFingerprint: "checkout" },
  } satisfies ThreadCreateRequestEncoded
  return Effect.gen(function* () {
    expect(yield* client.createThread(input)).toEqual({ threadId: "organization-thread" })
    const request = seen[0]
    if (request === undefined) return yield* Effect.die("Thread creation request was not sent")
    expect(yield* readJson(request)).toEqual(input)
  })
})

it.effect("creates an Orb Thread with project, workspace seed, and archive metadata", () => {
  const seen: Request[] = []
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return creationResponse("orb-thread")
        }),
    },
  })
  const input = {
    owner: { kind: "personal" },
    threadId: "orb-thread",
    target: "orb",
    projectId: "project",
    workspaceSeedId: "workspace-seed",
    archiveThreadId: "archived-thread",
  } satisfies ThreadCreateRequestEncoded
  return Effect.gen(function* () {
    expect(yield* client.createThread(input)).toEqual({ threadId: "orb-thread" })
    const request = seen[0]
    if (request === undefined) return yield* Effect.die("Thread creation request was not sent")
    expect(yield* readJson(request)).toEqual(input)
  })
})

it.effect("rejects invalid Thread creation placements before requesting credentials or transport", () => {
  const seen: Request[] = []
  let headerCalls = 0
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return new Response(null, { status: 201 })
        }),
    },
    requestHeaders: () =>
      Effect.sync(() => {
        headerCalls += 1
        return {}
      }),
  })
  const missingRunnerTarget = runnerThread("missing-runner-target")
  Reflect.deleteProperty(missingRunnerTarget, "runnerTarget")
  const runnerWithWorkspaceSeed = runnerThread("runner-with-workspace-seed")
  Reflect.set(runnerWithWorkspaceSeed, "workspaceSeedId", "workspace-seed")
  const orbWithRunnerTarget = {
    owner: { kind: "personal" },
    threadId: "orb-with-runner-target",
    target: "orb",
  } satisfies ThreadCreateRequestEncoded
  Reflect.set(orbWithRunnerTarget, "runnerTarget", { deviceId: "runner-device", checkoutFingerprint: "checkout" })
  return Effect.gen(function* () {
    for (const input of [missingRunnerTarget, runnerWithWorkspaceSeed, orbWithRunnerTarget]) {
      const result = yield* Effect.result(client.createThread(input))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("protocol")
    }
    expect(headerCalls).toBe(0)
    expect(seen).toEqual([])
  })
})

it.effect("repeats the caller Thread ID with fresh headers and no Session admission", () => {
  const seen: Request[] = []
  let headerCalls = 0
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return creationResponse("stable-thread")
        }),
    },
    requestHeaders: ({ method, url }) =>
      Effect.sync(() => {
        headerCalls += 1
        return {
          authorization: `DPoP access-${headerCalls}`,
          dpop: `proof-${method}-${url}-${headerCalls}`,
        }
      }),
  })
  const input = runnerThread("stable-thread")
  return Effect.gen(function* () {
    expect(yield* client.createThread(input)).toEqual({ threadId: "stable-thread" })
    expect(yield* client.createThread(input)).toEqual({ threadId: "stable-thread" })
    expect(input.threadId).toBe("stable-thread")
    expect(headerCalls).toBe(2)
    expect(seen).toHaveLength(2)
    for (const [index, request] of seen.entries()) {
      expect(request.url).toBe("https://rika.test/api/v2/threads")
      expect(request.headers.get("authorization")).toBe(`DPoP access-${index + 1}`)
      expect(request.headers.get("dpop")).toBe(`proof-POST-https://rika.test/api/v2/threads-${index + 1}`)
      expect(request.headers.get("x-command-id")).toBeNull()
      expect(yield* readJson(request)).toEqual(input)
    }
  })
})

it.effect("archives the exact Thread with fresh request authentication", () => {
  const seen: Request[] = []
  let headerCalls = 0
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return archiveResponse("archived-thread")
        }),
    },
    requestHeaders: ({ method, url }) =>
      Effect.sync(() => {
        headerCalls += 1
        return {
          authorization: `DPoP access-${headerCalls}`,
          dpop: `proof-${method}-${url}-${headerCalls}`,
        }
      }),
  })
  return Effect.gen(function* () {
    expect(yield* client.archiveThread("archived-thread")).toEqual({ threadId: "archived-thread", archived: true })
    expect(yield* client.archiveThread("archived-thread")).toEqual({ threadId: "archived-thread", archived: true })
    expect(headerCalls).toBe(2)
    for (const [index, request] of seen.entries()) {
      expect(request.method).toBe("POST")
      expect(request.url).toBe("https://rika.test/api/v2/threads/archived-thread/archive")
      expect(request.headers.get("authorization")).toBe(`DPoP access-${index + 1}`)
      expect(request.headers.get("dpop")).toBe(
        `proof-POST-https://rika.test/api/v2/threads/archived-thread/archive-${index + 1}`,
      )
      expect(request.headers.get("content-type")).toBeNull()
    }
  })
})

it.effect("rejects network, product error, and mismatched Thread creation receipts", () => {
  const network = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () => Effect.fail(ProductClientError.make({ kind: "network", message: "offline" })),
    },
  })
  const productError = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () => Effect.succeed(new Response(null, { status: 403 })),
    },
  })
  const mismatchedReceipt = makeProductClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () => Effect.succeed(creationResponse("different-thread")),
    },
  })
  return Effect.gen(function* () {
    const networkResult = yield* Effect.result(network.createThread(runnerThread("network-thread")))
    expect(networkResult._tag).toBe("Failure")
    if (networkResult._tag === "Failure") expect(networkResult.failure.kind).toBe("network")

    const productErrorResult = yield* Effect.result(productError.createThread(runnerThread("forbidden-thread")))
    expect(productErrorResult._tag).toBe("Failure")
    if (productErrorResult._tag === "Failure") {
      expect(productErrorResult.failure.kind).toBe("forbidden")
      expect(productErrorResult.failure.status).toBe(403)
    }

    const mismatchResult = yield* Effect.result(mismatchedReceipt.createThread(runnerThread("expected-thread")))
    expect(mismatchResult._tag).toBe("Failure")
    if (mismatchResult._tag === "Failure") expect(mismatchResult.failure.kind).toBe("protocol")
  })
})

it.effect("rejects a mismatched Thread archive receipt", () => {
  const client = makeProductClient({
    baseUrl: "https://rika.test",
    transport: { request: () => Effect.succeed(archiveResponse("different-thread")) },
  })
  return client.archiveThread("expected-thread").pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error.kind).toBe("protocol"))),
  )
})
