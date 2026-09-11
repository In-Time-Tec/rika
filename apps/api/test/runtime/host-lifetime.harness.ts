import { BunCrypto } from "@effect/platform-bun"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { ExecutableResolver, LocalScheduler } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"
import { hostEffect, rikaAgent } from "../../src/runtime/host"
import { threadContext, unavailableWorkspace, workspaceBinding } from "../fixtures/context"

it.live("keeps hosted model resources alive through execution and releases them with the owner scope", () =>
  Effect.gen(function* () {
    const events: string[] = []
    const model = Layer.effect(
      LanguageModel.LanguageModel,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => void events.push("acquired")),
          () => Effect.sync(() => void events.push("released")),
        )
        return yield* LanguageModel.LanguageModel
      }),
    ).pipe(Layer.provide(TestModel.layer([TestModel.turn([TestModel.text("ready")])])))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const bucket = yield* DurabilityTesting.make()
        const runtime = durabilityLayer({
          environment: "host-lifetime-test",
          tenant: "owner",
          partition: "thread-lifetime",
          addresses: [],
        }).pipe(
          Layer.provide(ExecutableResolver.layerStatic([])),
          Layer.provide(DurabilityTesting.layer(bucket)),
          Layer.provide(BunCrypto.layer),
        )
        yield* Effect.gen(function* () {
          const host = yield* hostEffect({
            revision: "lifetime-test",
            workspace: unavailableWorkspace(workspaceBinding),
            context: yield* threadContext(workspaceBinding, "rika-v2:owner:lifetime", model),
          })
          expect(events).toEqual(["acquired"])
          yield* activate
          const session = yield* host.sessions.create({ id: "rika-v2:owner:lifetime", agent: rikaAgent.name })
          const run = yield* host.runs.startByName(session.id, rikaAgent.name, "hello")
          const scheduler = yield* LocalScheduler.LocalScheduler
          yield* scheduler.drain({ fuel: 64 })
          expect(yield* run.await.pipe(Effect.timeout("10 seconds"))).toBe("ready")
          expect(events).toEqual(["acquired"])
        }).pipe(Effect.provide(yield* Layer.build(runtime)))
      }),
    )
    expect(events).toEqual(["acquired", "released"])
  }),
)
