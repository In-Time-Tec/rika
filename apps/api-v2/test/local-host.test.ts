import { BunCrypto } from "@effect/platform-bun"
/* oxlint-disable effecttsgo/effect-succeed-with-void -- auth rejection fixture returns no principal by design. */
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, Response as AiResponse } from "effect/unstable/ai"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import * as DurabilityTesting from "generalist/testing/durability"
import { makeApiV2LocalHost } from "../src/hosted/local-host"
import { threadPartition, type ThreadExecutionBinding } from "../src/hosted/partition"
import type { ProductAuthorityService } from "../src/hosted/product-authority"
import type { RuntimeGateway } from "../src/hosted/runtime-gateway"
import type { RunnerWorkspaceService } from "../src/hosted/host"

const usage = AiResponse.Usage.make({
  inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})

const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        AiResponse.makePart("text", { text: "ready" }),
        AiResponse.makePart("finish", { reason: "stop", usage, response: undefined }),
      ]),
    streamText: () =>
      Stream.make(
        AiResponse.makePart("text-delta", { id: "ready", delta: "ready" }),
        AiResponse.makePart("finish", { reason: "stop", usage, response: undefined }),
      ),
  }),
)

const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" })
const binding: ThreadExecutionBinding = {
  partition,
  placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
}
const authority: ProductAuthorityService = {
  authenticateBearer: () => Effect.succeed({ id: "user", tenantId: "owner", role: "controller" }),
  threadBinding: () => Effect.succeed(binding),
  resourceThread: () => Effect.succeed(partition.threadId),
  authorize: () => Effect.succeed(true),
}
const gateway: RuntimeGateway = {
  ensureRootSession: () => Effect.succeed({ sessionId: partition.rootSessionId, created: true }),
  handle: () => Effect.succeed(new Response("upstream")),
}
const workspace: RunnerWorkspaceService = {
  placement: binding.placement,
  execute: () => Effect.succeed({ outcome: "completed", exitCode: 0, stdout: "", stderr: "" }),
}

it.effect("creates an explicit local Rika/Rivet host with one registry lifecycle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const storage = Layer.merge(DurabilityTesting.layer(bucket), BunCrypto.layer)
      const host = yield* makeApiV2LocalHost({
        authority,
        environment: "test",
        storage,
        model,
        revision: "test-build",
        workspace: () => Effect.succeed(workspace),
        gateway,
        registry: {
          runtime: "native",
          endpoint: "http://127.0.0.1:6420",
          startEngine: false,
          startServices: false,
          noWelcome: true,
        },
        startRegistry: false,
      })
      const response = yield* Effect.tryPromise(() => host.fetch(new Request("https://rika.test/healthz")))
      yield* Effect.tryPromise(() => host.close())
      expect(response.status).toBe(200)
      expect(host.registry.config.use.rikaRuntime).toBeDefined()
    }),
  ),
)

it.effect("rejects unauthenticated upgrades before any gateway transport forwarding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let forwarded = 0
      const unauthenticated: ProductAuthorityService = {
        authenticateBearer: () =>
          Effect.succeed(undefined),
        threadBinding: () => Effect.succeed(binding),
        resourceThread: () => Effect.succeed(partition.threadId),
        authorize: () => Effect.succeed(true),
      }
      const response = yield* makeApiV2LocalHost({
        authority: unauthenticated,
        environment: "test",
        storage: Layer.merge(DurabilityTesting.layer(yield* DurabilityTesting.make()), BunCrypto.layer),
        model,
        revision: "test-build",
        workspace: () => Effect.succeed(workspace),
        gateway: {
          ensureRootSession: gateway.ensureRootSession,
          handle: () => {
            forwarded += 1
            return Effect.succeed(new Response("must not forward"))
          },
        },
        registry: {
          runtime: "native",
          endpoint: "http://127.0.0.1:6420",
          startEngine: false,
          startServices: false,
          noWelcome: true,
        },
        startRegistry: false,
      }).pipe(
        Effect.flatMap((host) =>
          Effect.tryPromise(() =>
            host.fetch(
              new Request("https://rika.test/api/v2/threads/thread/runtime/sessions/root/ws", {
                headers: { upgrade: "websocket", connection: "Upgrade" },
              }),
              { send: () => undefined, close: () => undefined },
            ),
          ).pipe(Effect.tap(() => Effect.tryPromise(() => host.close()))),
        ),
      )
      expect(response.status).toBe(401)
      expect(forwarded).toBe(0)
    }),
  ),
)
