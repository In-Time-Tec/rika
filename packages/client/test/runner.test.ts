import { expect, it } from "@effect/vitest"
import { WorkspaceBinding, workspaceExecutorWebSocketProtocol } from "@rika/execution"
import { CheckoutFingerprint, RunnerProfile } from "@rika/product/runner-registration"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeRunnerClient } from "../src/runner"
import { ProductClientError } from "../src/product"

const profile = () =>
  Schema.decodeSync(RunnerProfile)({
    protocolVersion: 2,
    workspaceIdentity: "workspace",
    projectId: "project",
    repository: {
      identity: "in-time-tec/rika",
      remoteUrl: "https://github.com/in-time-tec/rika",
      headRevision: "0123456789abcdef",
      branch: "main",
    },
    nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.3.0", trustMode: "trusted-local" },
    capabilities: { nativeTools: true, checkpoints: true, pty: true },
  })

const runnerBinding = () =>
  Schema.decodeSync(WorkspaceBinding)({
    workspaceId: "workspace",
    assignmentId: "assignment",
    generation: 7,
    placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
    buildId: "build-7",
    protocolVersion: 2,
  })

const orbBinding = () =>
  Schema.decodeSync(WorkspaceBinding)({
    workspaceId: "workspace",
    assignmentId: "assignment",
    generation: 7,
    placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
    buildId: "build-7",
    protocolVersion: 2,
  })

const encodeBinding = Schema.encodeSync(Schema.fromJsonString(WorkspaceBinding))
const fingerprint = Schema.decodeSync(CheckoutFingerprint)("checkout/%")

it.effect("creates a lazy Runner client without authorizing or sending a request", () => {
  let authorizations = 0
  let requests = 0
  makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () =>
        Effect.sync(() => {
          requests += 1
          return new Response(null, { status: 204 })
        }),
    },
    requestHeaders: () =>
      Effect.sync(() => {
        authorizations += 1
        return {}
      }),
  })
  expect(authorizations).toBe(0)
  expect(requests).toBe(0)
  return Effect.void
})

it.effect("registers a Runner and updates its remote Thread preference with encoded paths and fresh DPoP", () => {
  const requests: Request[] = []
  let authorizations = 0
  const client = makeRunnerClient({
    baseUrl: "https://rika.test/product",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return new Response(null, { status: 204 })
        }),
    },
    requestHeaders: ({ method, url }) =>
      Effect.sync(() => {
        authorizations += 1
        return { authorization: `DPoP access-${authorizations}`, dpop: `proof-${method}-${url}` }
      }),
  })
  return Effect.gen(function* () {
    const registration = profile()
    yield* client.register({ checkoutFingerprint: fingerprint, profile: registration })
    yield* client.setRemoteThreadCreation({ checkoutFingerprint: fingerprint, preference: "allowed" })
    const registered = requests[0]
    const preference = requests[1]
    if (registered === undefined || preference === undefined) return yield* Effect.die("Runner requests were not sent")
    expect(authorizations).toBe(2)
    expect(registered.method).toBe("PUT")
    expect(registered.url).toBe("https://rika.test/product/api/v2/runners/checkout%2F%25")
    expect(registered.headers.get("authorization")).toBe("DPoP access-1")
    expect(registered.headers.get("dpop")).toBe("proof-PUT-https://rika.test/product/api/v2/runners/checkout%2F%25")
    expect(registered.headers.get("content-type")).toBe("application/json")
    expect(yield* Effect.tryPromise(() => registered.json())).toEqual(registration)
    expect(preference.method).toBe("PUT")
    expect(preference.url).toBe("https://rika.test/product/api/v2/runners/checkout%2F%25/remote-thread-creation")
    expect(preference.headers.get("authorization")).toBe("DPoP access-2")
    expect(preference.headers.get("dpop")).toBe(
      "proof-PUT-https://rika.test/product/api/v2/runners/checkout%2F%25/remote-thread-creation",
    )
    expect(yield* Effect.tryPromise(() => preference.json())).toEqual({ preference: "allowed" })
  })
})

const encodePollResponse = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      claimed: Schema.Boolean,
      assignment: Schema.NullOr(
        Schema.Struct({
          assignmentId: Schema.String,
          threadId: Schema.String,
          workspaceId: Schema.String,
          resume: Schema.Boolean,
          leaseExpiresAt: Schema.NullOr(Schema.Finite),
        }),
      ),
    }),
  ),
)

it.effect("polls checkout-scoped Runner assignments with the supervisor identity and active set", () => {
  const requests: Request[] = []
  const client = makeRunnerClient({
    baseUrl: "https://rika.test/product",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return new Response(
            encodePollResponse({
              claimed: true,
              assignment: {
                assignmentId: "assignment-1",
                threadId: "thread-1",
                workspaceId: "workspace-1",
                resume: true,
                leaseExpiresAt: 1_700_000_000_000,
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        }),
    },
    requestHeaders: ({ method, url }) =>
      Effect.succeed({ authorization: "DPoP access", dpop: `proof-${method}-${url}` }),
  })
  return Effect.gen(function* () {
    const result = yield* client.poll({
      checkoutFingerprint: fingerprint,
      supervisorId: "supervisor-1",
      activeAssignmentIds: ["assignment-0"],
    })
    expect(result).toEqual({
      claimed: true,
      assignment: {
        assignmentId: "assignment-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        resume: true,
        leaseExpiresAt: 1_700_000_000_000,
      },
    })
    const request = requests[0]
    if (request === undefined) return yield* Effect.die("Runner poll request was not sent")
    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://rika.test/product/api/v2/runners/checkout%2F%25/poll")
    expect(request.headers.get("content-type")).toBe("application/json")
    expect(request.headers.get("dpop")).toBe("proof-POST-https://rika.test/product/api/v2/runners/checkout%2F%25/poll")
    expect(yield* Effect.tryPromise(() => request.json())).toEqual({
      supervisorId: "supervisor-1",
      activeAssignmentIds: ["assignment-0"],
    })
  })
})

it.effect("rejects invalid Runner poll inputs before authorization or transport", () => {
  let authorizations = 0
  let requests = 0
  const client = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () =>
        Effect.sync(() => {
          requests += 1
          return new Response(null)
        }),
    },
    requestHeaders: () =>
      Effect.sync(() => {
        authorizations += 1
        return {}
      }),
  })
  return Effect.gen(function* () {
    for (const input of [
      { checkoutFingerprint: fingerprint, supervisorId: "", activeAssignmentIds: [] },
      {
        checkoutFingerprint: fingerprint,
        supervisorId: "supervisor",
        activeAssignmentIds: Array.from({ length: 65 }, (_, index) => `assignment-${index}`),
      },
      { checkoutFingerprint: "invalid\n", supervisorId: "supervisor", activeAssignmentIds: [] },
    ]) {
      const result = yield* Effect.result(client.poll(input))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("protocol")
    }
    expect(authorizations).toBe(0)
    expect(requests).toBe(0)
  })
})

it.effect("decodes the complete canonical Runner binding and rejects other placements", () => {
  const binding = runnerBinding()
  const requests: Request[] = []
  const client = makeRunnerClient({
    baseUrl: "https://rika.test/product",
    transport: {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return new Response(encodeBinding(binding), { headers: { "content-type": "application/json" } })
        }),
    },
    requestHeaders: ({ method, url }) =>
      Effect.succeed({ authorization: "DPoP access", dpop: `proof-${method}-${url}` }),
  })
  const orb = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: { request: () => Effect.succeed(new Response(encodeBinding(orbBinding()))) },
    requestHeaders: () => Effect.succeed({}),
  })
  return Effect.gen(function* () {
    expect(yield* client.binding("thread /%")).toEqual(binding)
    const request = requests[0]
    if (request === undefined) return yield* Effect.die("Runner binding request was not sent")
    expect(request.method).toBe("GET")
    expect(request.url).toBe("https://rika.test/product/api/v2/threads/thread%20%2F%25/executor/binding")
    expect(request.headers.get("dpop")).toBe(
      "proof-GET-https://rika.test/product/api/v2/threads/thread%20%2F%25/executor/binding",
    )
    const rejected = yield* Effect.result(orb.binding("thread"))
    expect(rejected._tag).toBe("Failure")
    if (rejected._tag === "Failure") expect(rejected.failure.kind).toBe("protocol")
  })
})

it.effect("builds same-origin enrollment upgrades with a literal protocol array and fresh headers", () => {
  const authorizations: Array<{ readonly method: string; readonly url: string }> = []
  let requests = 0
  const requestHeaders = ({ method, url }: { readonly method: string; readonly url: string }) =>
    Effect.sync(() => {
      authorizations.push({ method, url })
      return { authorization: `DPoP access-${authorizations.length}`, dpop: `proof-${url}` }
    })
  const secure = makeRunnerClient({
    baseUrl: "https://rika.test/product",
    transport: {
      request: () =>
        Effect.sync(() => {
          requests += 1
          return new Response(null)
        }),
    },
    requestHeaders,
  })
  const insecure = makeRunnerClient({
    baseUrl: "http://localhost:4310/base",
    transport: { request: () => Effect.die("Enrollment must not send a request") },
    requestHeaders,
  })
  return Effect.gen(function* () {
    const first = yield* secure.enrollmentRequest("thread /%")
    const second = yield* secure.enrollmentRequest("thread /%")
    const local = yield* insecure.enrollmentRequest("thread")
    expect(first.url).toBe("wss://rika.test/product/api/v2/threads/thread%20%2F%25/executor")
    expect(first.headers).toEqual({ authorization: "DPoP access-1", dpop: `proof-${first.url}` })
    expect(first.protocols).toEqual([workspaceExecutorWebSocketProtocol])
    expect(Array.isArray(first.protocols)).toBe(true)
    expect(second.headers).toEqual({ authorization: "DPoP access-2", dpop: `proof-${second.url}` })
    expect(local.url).toBe("ws://localhost:4310/base/api/v2/threads/thread/executor")
    expect(local.protocols).toEqual([workspaceExecutorWebSocketProtocol])
    expect(authorizations).toEqual([
      { method: "GET", url: first.url },
      { method: "GET", url: second.url },
      { method: "GET", url: local.url },
    ])
    expect(requests).toBe(0)
  })
})

it.effect("rejects invalid Runner inputs and base URLs before authorization or transport", () => {
  let authorizations = 0
  let requests = 0
  const client = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () =>
        Effect.sync(() => {
          requests += 1
          return new Response(null)
        }),
    },
    requestHeaders: () =>
      Effect.sync(() => {
        authorizations += 1
        return {}
      }),
  })
  const invalidProfile = profile()
  Reflect.set(invalidProfile, "unexpected", true)
  const invalidFingerprint = "invalid\n"
  const invalidBases = [
    "ftp://rika.test",
    "https://user:password@rika.test",
    "https://rika.test/product?query=value",
    "https://rika.test/product#fragment",
  ]
  return Effect.gen(function* () {
    for (const threadId of ["", "x".repeat(513)]) {
      const result = yield* Effect.result(client.binding(threadId))
      expect(result._tag).toBe("Failure")
    }
    const profileResult = yield* Effect.result(
      client.register({ checkoutFingerprint: fingerprint, profile: invalidProfile }),
    )
    expect(profileResult._tag).toBe("Failure")
    const fingerprintResult = yield* Effect.result(
      client.register({ checkoutFingerprint: invalidFingerprint, profile: profile() }),
    )
    expect(fingerprintResult._tag).toBe("Failure")
    for (const baseUrl of invalidBases) {
      const invalid = makeRunnerClient({
        baseUrl,
        transport: { request: () => Effect.die("Invalid base URL must not send a request") },
        requestHeaders: () => Effect.die("Invalid base URL must not request authorization"),
      })
      const result = yield* Effect.result(invalid.enrollmentRequest("thread"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("protocol")
    }
    expect(authorizations).toBe(0)
    expect(requests).toBe(0)
  })
})

it.effect("maps Runner transport, authorization, malformed, and oversized binding responses safely", () => {
  const unauthorized = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: { request: () => Effect.succeed(new Response(null, { status: 401 })) },
    requestHeaders: () => Effect.succeed({}),
  })
  const forbidden = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: { request: () => Effect.succeed(new Response(null, { status: 403 })) },
    requestHeaders: () => Effect.succeed({}),
  })
  const malformed = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: { request: () => Effect.succeed(new Response("{", { status: 200 })) },
    requestHeaders: () => Effect.succeed({}),
  })
  const oversized = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: { request: () => Effect.succeed(new Response("x".repeat(16_385), { status: 200 })) },
    requestHeaders: () => Effect.succeed({}),
  })
  const unavailable = makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () => Effect.fail(ProductClientError.make({ kind: "protocol", message: "transport detail" })),
    },
    requestHeaders: () => Effect.succeed({}),
  })
  return Effect.gen(function* () {
    const unauthorizedResult = yield* Effect.result(unauthorized.binding("thread"))
    const forbiddenResult = yield* Effect.result(forbidden.binding("thread"))
    const malformedResult = yield* Effect.result(malformed.binding("thread"))
    const oversizedResult = yield* Effect.result(oversized.binding("thread"))
    const unavailableResult = yield* Effect.result(unavailable.binding("thread"))
    for (const [result, kind] of [
      [unauthorizedResult, "unauthorized"],
      [forbiddenResult, "forbidden"],
      [malformedResult, "protocol"],
      [oversizedResult, "protocol"],
      [unavailableResult, "network"],
    ] as const) {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe(kind)
    }
  })
})

it.effect("bounds a never-ending binding response and releases its reader", () =>
  Effect.gen(function* () {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
      },
    })
    const client = makeRunnerClient({
      baseUrl: "https://rika.test",
      transport: { request: () => Effect.succeed(new Response(body, { status: 200 })) },
      requestHeaders: () => Effect.succeed({}),
    })
    const reading = yield* client.binding("thread").pipe(Effect.flip, Effect.forkChild)
    yield* TestClock.adjust("10 seconds")
    const error = yield* Fiber.join(reading)
    expect(error.kind).toBe("protocol")
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  }),
)

it.effect("cancels rejected response bodies without waiting indefinitely for cleanup", () =>
  Effect.gen(function* () {
    let cancelled = false
    const client = makeRunnerClient({
      baseUrl: "https://rika.test",
      transport: {
        request: () =>
          Effect.succeed(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel: () => {
                  cancelled = true
                  return Promise.withResolvers<void>().promise
                },
              }),
              { status: 403 },
            ),
          ),
      },
      requestHeaders: () => Effect.succeed({}),
    })
    const reading = yield* client.binding("thread").pipe(Effect.flip, Effect.forkChild)
    yield* TestClock.adjust("100 millis")
    expect((yield* Fiber.join(reading)).kind).toBe("forbidden")
    expect(cancelled).toBe(true)
  }),
)

it.effect("bounds request acquisition and interrupts pending transport work", () =>
  Effect.gen(function* () {
    let interrupted = false
    const client = makeRunnerClient({
      baseUrl: "https://rika.test",
      transport: {
        request: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
      },
      requestHeaders: () => Effect.succeed({}),
    })
    const reading = yield* client.binding("thread").pipe(Effect.flip, Effect.forkChild)
    yield* TestClock.adjust("10 seconds")
    expect((yield* Fiber.join(reading)).kind).toBe("network")
    expect(interrupted).toBe(true)
  }),
)
