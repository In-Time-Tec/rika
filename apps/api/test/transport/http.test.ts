import { Effect } from "effect"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import type { Principal } from "generalist/server"
import { handleApiV2Request } from "../../src/transport/http"
import { decodeWorkspaceBinding, threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"
import type { ProductAuthorityService } from "../../src/product/authority"
import type { RootSessionReceipt, RuntimeGateway } from "../../src/transport/runtime-gateway"

const principal: Principal = { id: "user", tenantId: "owner", role: "controller" }
const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" })
const binding: ThreadExecutionBinding = {
  partition,
  placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
  workspaceBinding: decodeWorkspaceBinding({
    workspaceId: "workspace",
    assignmentId: "assignment",
    generation: 1,
    placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
    buildId: "build",
    protocolVersion: 1,
  }),
}

const authority = (allowed: boolean): ProductAuthorityService => ({
  authenticateBearer: () => Effect.succeed(principal),
  threadBinding: () => Effect.succeed(binding),
  resourceThread: () => Effect.succeed(partition.threadId),
  authorize: () => Effect.succeed(allowed),
})

const gateway = (calls: { ensure: number; handle: number }, receipt: RootSessionReceipt): RuntimeGateway => ({
  ensureRootSession: (_partition, _commandId) => {
    calls.ensure += 1
    return Effect.succeed(receipt)
  },
  handle: () => {
    calls.handle += 1
    return Effect.succeed(new Response("upstream"))
  },
})

const request = (path: string, init?: RequestInit) =>
  new Request(`https://rika.test${path}`, {
    headers: { authorization: "Bearer valid" },
    ...init,
  })

it.effect("Thread plus Session creation retries converge without submitting a Run", () =>
  Effect.gen(function* () {
    const calls = { ensure: 0, handle: 0 }
    const first = yield* handleApiV2Request({
      authority: authority(true),
      gateway: gateway(calls, { sessionId: partition.rootSessionId, created: true }),
      environment: "test",
      request: request("/api/v2/threads/thread/session", {
        method: "POST",
        headers: { authorization: "Bearer valid", "x-command-id": "thread:session" },
      }),
    })
    expect(first.status).toBe(201)
    const retry = yield* handleApiV2Request({
      authority: authority(true),
      gateway: gateway(calls, { sessionId: partition.rootSessionId, created: false }),
      environment: "test",
      request: request("/api/v2/threads/thread/session", {
        method: "POST",
        headers: { authorization: "Bearer valid", "x-command-id": "thread:session" },
      }),
    })
    expect(retry.status).toBe(200)
    expect(calls.ensure).toBe(2)
    expect(calls.handle).toBe(0)
  }),
)

it.effect("a revoked product grant blocks direct upstream Session routes", () =>
  Effect.gen(function* () {
    const calls = { ensure: 0, handle: 0 }
    const response = yield* handleApiV2Request({
      authority: authority(false),
      gateway: gateway(calls, { sessionId: partition.rootSessionId, created: false }),
      environment: "test",
      request: request(`/sessions/${encodeURIComponent(partition.rootSessionId)}/queue`, { method: "POST" }),
    })
    expect(response.status).toBe(403)
    expect(calls.ensure).toBe(0)
    expect(calls.handle).toBe(0)
  }),
)

it.effect("routes opaque Runs and child Sessions through an explicit Thread runtime prefix", () =>
  Effect.gen(function* () {
    const calls: Request[] = []
    const response = yield* handleApiV2Request({
      authority: authority(true),
      gateway: {
        ensureRootSession: () => Effect.succeed({ sessionId: partition.rootSessionId, created: true }),
        handle: (_partition, forwarded) => {
          calls.push(forwarded)
          return Effect.succeed(new Response("upstream"))
        },
      },
      environment: "test",
      request: request("/api/v2/threads/thread/runtime/runs/opaque-run?cursor=abc&limit=2", { method: "GET" }),
    })
    expect(response.status).toBe(200)
    expect(calls[0]?.url).toBe("https://rika.test/runs/opaque-run?cursor=abc&limit=2")
    expect(calls[0]?.headers.get("x-rika-original-request-url")).toBe(
      "https://rika.test/api/v2/threads/thread/runtime/runs/opaque-run?cursor=abc&limit=2",
    )
  }),
)

it.effect("passes DPoP credentials and the original request to repository authority", () =>
  Effect.gen(function* () {
    let capturedToken: string | undefined
    let capturedRequest: Request | undefined
    let forwarded: Request | undefined
    const response = yield* handleApiV2Request({
      authority: {
        ...authority(true),
        authenticateBearer: (token, context) => {
          capturedToken = token
          capturedRequest = context?.request
          return Effect.succeed(principal)
        },
        downstreamCredential: () => Effect.succeed("rika-ds-test"),
      },
      gateway: {
        ensureRootSession: () => Effect.succeed({ sessionId: partition.rootSessionId, created: false }),
        handle: (_partition, forwardedRequest) => {
          forwarded = forwardedRequest
          return Effect.succeed(new Response("upstream"))
        },
      },
      environment: "test",
      request: new Request("https://rika.test/api/v2/threads/thread/runtime/runs/opaque?cursor=abc", {
        method: "POST",
        headers: {
          authorization: "DPoP access-token",
          dpop: "proof",
          "x-rika-downstream-credential": "attacker-supplied",
          "x-rika-original-request-method": "GET",
          "content-type": "application/json",
        },
        body: '{"prompt":"hello"}',
      }),
    })
    expect(response.status).toBe(200)
    expect(capturedToken).toBe("access-token")
    expect(capturedRequest?.method).toBe("POST")
    expect(capturedRequest?.url).toBe("https://rika.test/api/v2/threads/thread/runtime/runs/opaque?cursor=abc")
    expect(capturedRequest?.headers.get("authorization")).toBe("DPoP access-token")
    expect(capturedRequest?.headers.get("dpop")).toBe("proof")
    expect(capturedRequest?.headers.get("content-type")).toBe("application/json")
    expect(capturedRequest?.headers.get("x-rika-downstream-credential")).toBeNull()
    expect(forwarded?.headers.get("x-rika-downstream-credential")).toBe("rika-ds-test")
    expect(forwarded?.headers.get("x-rika-original-request-method")).toBe("POST")
    const capturedBody = yield* Effect.tryPromise(() =>
      // ast-grep-ignore: effect-prefer-promise-composition -- test consumes a foreign Fetch body.
      capturedRequest === undefined ? Promise.resolve(undefined) : capturedRequest.clone().text(),
    )
    expect(capturedBody).toBe('{"prompt":"hello"}')
  }),
)
