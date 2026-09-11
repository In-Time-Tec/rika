import { Effect } from "effect"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import type { Principal } from "generalist/server"
import { authorizedRuntimeRequest, type RuntimeGateway } from "../../src/transport/runtime-gateway"
import { decodeWorkspaceBinding, threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"
import type { ProductAuthorityService } from "../../src/product/authority"

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

const gateway = (called: { value: number }): RuntimeGateway => ({
  ensureRootSession: () => Effect.succeed({ sessionId: partition.rootSessionId, created: true }),
  handle: () => {
    called.value += 1
    return Effect.succeed(new Response("ok"))
  },
})

it.effect("rechecks product revocation before a direct upstream request", () =>
  Effect.gen(function* () {
    const called = { value: 0 }
    const result = yield* Effect.result(
      authorizedRuntimeRequest({
        authority: authority(false),
        gateway: gateway(called),
        principal,
        resource: { type: "session", id: partition.rootSessionId },
        partition,
        request: new Request("https://rika.test/sessions", { method: "POST" }),
      }),
    )
    expect(result._tag).toBe("Failure")
    expect(called.value).toBe(0)
  }),
)

it.effect("forwards only an authorized request to the one Generalist gateway", () =>
  Effect.gen(function* () {
    const called = { value: 0 }
    const response = yield* authorizedRuntimeRequest({
      authority: authority(true),
      gateway: gateway(called),
      principal,
      resource: { type: "session", id: partition.rootSessionId },
      partition,
      request: new Request("https://rika.test/sessions", { method: "GET" }),
    })
    expect(response.status).toBe(200)
    expect(called.value).toBe(1)
  }),
)
