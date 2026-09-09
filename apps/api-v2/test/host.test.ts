import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { ExecutableResolver } from "generalist/runtime"
import * as DurabilityTesting from "generalist/testing/durability"
/* oxlint-disable effecttsgo/strict-effect-provide -- the test builds one isolated Runtime scope. */
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { hostEffect, type RunnerWorkspaceService } from "../src/hosted/host"

const usage = Response.Usage.make({
  inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})

const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        Response.makePart("text", { text: "ready" }),
        Response.makePart("finish", { reason: "stop", usage, response: undefined }),
      ]),
    streamText: () =>
      Stream.make(
        Response.makePart("text-delta", { id: "ready", delta: "ready" }),
        Response.makePart("finish", { reason: "stop", usage, response: undefined }),
      ),
  }),
)

const workspace: RunnerWorkspaceService = {
  placement: { _tag: "Runner", checkoutFingerprint: "checkout", workspaceId: "workspace" },
  execute: () => Effect.succeed({ outcome: "completed", exitCode: 0, stdout: "", stderr: "" }),
}

it.effect("constructs and admits a Session through the published Generalist Host", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const runtime = durabilityLayer({
        environment: "test",
        tenant: "owner",
        partition: "thread-thread",
        addresses: [],
      }).pipe(
        Layer.provide(ExecutableResolver.layerStatic([])),
        Layer.provide(DurabilityTesting.layer(bucket)),
        Layer.provide(BunCrypto.layer),
      )
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostEffect({ revision: "test-build", model, workspace })
          yield* activate
          const session = yield* host.sessions.create({ id: "rika-v2:owner:thread", agent: "rika" })
          const receipt = yield* session.submit("hello", { commandId: "submit:1" })
          return { session, receipt }
        }).pipe(Effect.provide(runtime)),
      )
    }),
  )

  return program.pipe(
    Effect.tap(({ session, receipt }) =>
      Effect.sync(() => {
        expect(session.id).toBe("rika-v2:owner:thread")
        expect(receipt).toMatchObject({ id: "submit:1", revision: 1 })
      }),
    ),
  )
})

it.effect("reopens the same durable Session after an actor incarnation is replaced", () => {
  const sessionId = "rika-v2:owner:thread-replacement"
  const program = Effect.scoped(
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const runtime = durabilityLayer({
        environment: "test",
        tenant: "owner",
        partition: "thread-thread",
        addresses: [],
      }).pipe(
        Layer.provide(ExecutableResolver.layerStatic([])),
        Layer.provide(DurabilityTesting.layer(bucket)),
        Layer.provide(BunCrypto.layer),
      )
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostEffect({ revision: "test-build", model, workspace })
          yield* activate
          const session = yield* host.sessions.create({ id: sessionId, agent: "rika" })
          yield* session.submit("persist", { commandId: "submit:replacement" })
          return session.id
        }).pipe(Effect.provide(runtime)),
      )
      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostEffect({ revision: "test-build", model, workspace })
          yield* activate
          const session = yield* host.sessions.get(sessionId)
          return session.id
        }).pipe(Effect.provide(runtime)),
      )
      return { first, second }
    }),
  )

  return program.pipe(
    Effect.tap(({ first, second }) =>
      Effect.sync(() => {
        expect(first).toBe(sessionId)
        expect(second).toBe(sessionId)
      }),
    ),
  )
})
