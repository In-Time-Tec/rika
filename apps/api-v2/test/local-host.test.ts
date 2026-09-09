import { BunCrypto } from "@effect/platform-bun"
/* oxlint-disable effecttsgo/effect-succeed-with-void -- auth rejection fixture returns no principal by design. */
/* oxlint-disable effecttsgo/async-function -- ReadableStream fixtures are foreign Promise callbacks. */
/* oxlint-disable effecttsgo/run-effect-inside-effect -- foreign stream/socket fixtures bridge Effect to platform callbacks. */
/* oxlint-disable effecttsgo/global-fetch -- this test exercises the foreign Bun HTTP host boundary. */
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { LanguageModel, Response as AiResponse } from "effect/unstable/ai"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import * as DurabilityTesting from "generalist/testing/durability"
import { makeApiV2LocalHost, serveApiV2LocalHost } from "../src/hosted/local-host"
import { decodeWorkspaceBinding, threadPartition, type ThreadExecutionBinding } from "../src/hosted/partition"
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
  workspaceBinding: decodeWorkspaceBinding({
    workspaceId: "workspace",
    assignmentId: "assignment",
    generation: 1,
    placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
    buildId: "build",
    protocolVersion: 1,
  }),
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

const fetchHttp = (url: string) => globalThis.fetch(url)

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
        authenticateBearer: () => Effect.succeed(undefined),
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

it.effect("drains in-flight application requests before closing the Rivet registry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const host = yield* makeApiV2LocalHost({
        authority,
        environment: "test",
        storage: Layer.merge(DurabilityTesting.layer(yield* DurabilityTesting.make()), BunCrypto.layer),
        model,
        revision: "test-build",
        workspace: () => Effect.succeed(workspace),
        gateway: {
          ensureRootSession: gateway.ensureRootSession,
          handle: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return new Response("upstream")
            }),
        },
        registry: {
          runtime: "native",
          endpoint: "http://127.0.0.1:6420",
          startEngine: false,
          startServices: false,
          noWelcome: true,
        },
        startRegistry: false,
      })
      const request = new Request("https://rika.test/api/v2/threads/thread/runtime/runs/run", {
        headers: { authorization: "Bearer token" },
      })
      const fetchFiber = yield* Effect.forkChild(Effect.tryPromise(() => host.fetch(request)).pipe(Effect.orDie))
      yield* Deferred.await(started)
      const closeFiber = yield* Effect.forkChild(
        Effect.tryPromise(() => host.close()).pipe(Effect.orDie, Effect.andThen(Deferred.succeed(closed, undefined))),
      )
      yield* Effect.yieldNow
      expect(Option.isNone(yield* Deferred.poll(closed))).toBe(true)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fetchFiber)).status).toBe(200)
      yield* Fiber.join(closeFiber)
      expect(Option.isSome(yield* Deferred.poll(closed))).toBe(true)
    }),
  ),
)

it.effect("bounds local host close by cancelling held SSE and WebSocket clients", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const host = yield* makeApiV2LocalHost({
        authority,
        environment: "test",
        storage: Layer.merge(DurabilityTesting.layer(yield* DurabilityTesting.make()), BunCrypto.layer),
        model,
        revision: "test-build",
        workspace: () => Effect.succeed(workspace),
        gateway: {
          ensureRootSession: gateway.ensureRootSession,
          handle: (_partition, request, websocket) => {
            if (websocket !== undefined) return Effect.succeed(new Response(null, { status: 101 }))
            return Effect.succeed(
              new Response(
                new ReadableStream<Uint8Array>({
                  // ast-grep-ignore: effect-prefer-program-construction -- ReadableStream pull is a foreign stream callback.
                  async pull() {
                    // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- ReadableStream pull runs outside the Effect runtime.
                    await Effect.runPromise(Deferred.await(held))
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              ),
            )
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
      })
      const request = new Request("https://rika.test/api/v2/threads/thread/runtime/sessions/root/events", {
        headers: { authorization: "Bearer token" },
      })
      const response = yield* Effect.tryPromise(() => host.fetch(request))
      const socketClosed = yield* Deferred.make<void>()
      const websocket = {
        send: () => undefined,
        close: () => {
          void Effect.runPromise(Deferred.succeed(socketClosed, undefined))
        },
        addEventListener: (_type: string, listener: (_event: { readonly data: unknown }) => void) => {
          // ast-grep-ignore: effect-prefer-promise-composition -- WebSocket fixture bridges a foreign callback promise.
          void Effect.runPromise(Deferred.await(socketClosed)).then(() => listener({ data: undefined }))
        },
      }
      const websocketResponse = yield* Effect.tryPromise(() =>
        host.fetch(
          new Request("https://rika.test/api/v2/threads/thread/runtime/sessions/root/ws", {
            headers: { authorization: "Bearer token", upgrade: "websocket" },
          }),
          websocket,
        ),
      )
      expect(websocketResponse.status).toBe(101)
      const closeFiber = yield* Effect.forkChild(
        Effect.tryPromise(() => host.close()).pipe(Effect.orDie, Effect.andThen(Deferred.succeed(closed, undefined))),
      )
      yield* Effect.yieldNow
      expect(Option.isNone(yield* Deferred.poll(closed))).toBe(true)
      yield* Fiber.join(closeFiber)
      expect(Option.isSome(yield* Deferred.poll(closed))).toBe(true)
      expect(Option.isSome(yield* Deferred.poll(socketClosed))).toBe(true)
      expect(response.body).not.toBeNull()

      const reopened = yield* makeApiV2LocalHost({
        authority,
        environment: "test",
        storage: Layer.merge(DurabilityTesting.layer(yield* DurabilityTesting.make()), BunCrypto.layer),
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
      const followUp = yield* Effect.tryPromise(() => reopened.fetch(new Request("https://rika.test/healthz")))
      expect(followUp.status).toBe(200)
      const metadata = yield* Effect.tryPromise(() =>
        reopened.registry.handler(new Request("https://rika.test/api/rivet/metadata")),
      )
      expect(metadata.status).toBe(200)
      yield* Effect.tryPromise(() => reopened.close())
    }),
  ),
)

it.effect("reopens the Bun host after a graceful transport close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = {
        authority,
        environment: "test",
        storage: Layer.merge(DurabilityTesting.layer(yield* DurabilityTesting.make()), BunCrypto.layer),
        model,
        revision: "test-build",
        workspace: () => Effect.succeed(workspace),
        gateway,
        registry: {
          runtime: "native" as const,
          endpoint: "http://127.0.0.1:6420",
          startEngine: false,
          startServices: false,
          noWelcome: true,
        },
        startRegistry: false,
        port: 0,
      }
      const first = yield* serveApiV2LocalHost(options)
      const firstResponse = yield* Effect.tryPromise(() => fetchHttp(`${first.url}/healthz`))
      expect(firstResponse.status).toBe(200)
      yield* Effect.tryPromise(() => first.close())
      const second = yield* serveApiV2LocalHost(options)
      const secondResponse = yield* Effect.tryPromise(() => fetchHttp(`${second.url}/healthz`))
      expect(secondResponse.status).toBe(200)
      yield* Effect.tryPromise(() => second.close())
    }),
  ),
)
