import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { ThreadId } from "@rika/product/hosted-model"
import { TurnId } from "@rika/product/turn-record"
import { Config, Context, Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import {
  HostedPreviewBus,
  makeHostedPreviewBus,
  postgresHostedPreviewBusLayer,
  type HostedPreview,
} from "../../../src/hosted/thread/previews"

const threadId = ThreadId.make("thread-1")
const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const preview = (sequence: number): HostedPreview => ({
  threadId,
  turnId: TurnId.make("turn-1"),
  preview: {
    _tag: "ModelPreview",
    runId: "run-1",
    attemptFence: 1,
    turn: 0,
    modelCallId: "call-1",
    modelAttemptId: "attempt-1",
    attempt: 1,
    sequence,
    changes: [{ channel: "text", offset: sequence, delta: "x" }],
  },
})

it.effect("fans previews out only to the subscribed Thread", () =>
  Effect.gen(function* () {
    const { bus } = yield* makeHostedPreviewBus()
    const selected = yield* bus.subscribe(threadId)
    const foreignThreadId = ThreadId.make("thread-2")
    const foreign = yield* bus.subscribe(foreignThreadId)
    bus.publish(preview(0))
    expect(yield* selected.take).toEqual({ _tag: "Preview", value: preview(0) })
    const foreignPreview = { ...preview(1), threadId: foreignThreadId }
    bus.publish(foreignPreview)
    expect(yield* foreign.take).toEqual({ _tag: "Preview", value: foreignPreview })
  }),
)

it.effect("resets a slow subscriber instead of backpressuring publication", () =>
  Effect.gen(function* () {
    const forwarded: Array<HostedPreview> = []
    const { bus } = yield* makeHostedPreviewBus((value) => void forwarded.push(value))
    const subscription = yield* bus.subscribe(threadId)
    for (let sequence = 0; sequence < 65; sequence += 1) bus.publish(preview(sequence))
    expect(yield* subscription.take).toEqual({ _tag: "Reset" })
    expect(forwarded).toHaveLength(65)
  }),
)

it.effect.skipIf(databaseUrl === "")("fans a maximum UTF-8 preview between API replicas", () =>
  TestClock.withLive(
    Effect.scoped(
      Effect.gen(function* () {
        const layer = postgresHostedPreviewBusLayer({ databaseUrl: Redacted.make(databaseUrl) }).pipe(
          Layer.provide(BunCrypto.layer),
        )
        const first = Context.get(yield* Layer.build(layer), HostedPreviewBus)
        const second = Context.get(yield* Layer.build(layer), HostedPreviewBus)
        const subscription = yield* second.subscribe(threadId)
        const large = {
          ...preview(0),
          preview: {
            ...preview(0).preview,
            changes: [{ channel: "text" as const, offset: 0, delta: "界".repeat(4_096) }] as const,
          },
        }
        const publishing = yield* Effect.sleep("25 millis").pipe(
          Effect.andThen(Effect.sync(() => first.publish(large))),
          Effect.forever,
          Effect.forkChild,
        )
        // LISTEN can attach halfway through a fragmented publication. Its Reset is
        // intentional; require a complete subsequent preview within the same deadline.
        const delivered = yield* Effect.gen(function* () {
          while (true) {
            const delivery = yield* subscription.take
            if (delivery._tag === "Preview") return delivery
          }
        }).pipe(Effect.timeout("5 seconds"))
        yield* Fiber.interrupt(publishing)
        expect(delivered).toEqual({ _tag: "Preview", value: large })
      }),
    ),
  ),
)
