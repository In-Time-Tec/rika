import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { ExecutorRuntime, layer } from "../src/executor-runtime"
import type { ExecutorFence, ExecutorProtocolError, ExecutorSessionWire } from "../src/protocol"

const fence: ExecutorFence = {
  target: "e2b",
  assignmentId: "assignment-1",
  generation: 3,
  instanceId: "sandbox-3",
  executorId: "executor-3",
}

const run = <A, E>(
  effect: Effect.Effect<A, E, ExecutorRuntime>,
  runtime: Layer.Layer<ExecutorRuntime, ExecutorProtocolError>,
) => Effect.scoped(Effect.flatMap(Layer.build(runtime), (context) => Effect.provide(effect, context)))

describe("ExecutorRuntime", () => {
  it.effect("persists a resumable session and replays only from the controller-acknowledged cursor", () => {
    let persisted: ExecutorSessionWire | undefined
    const first = layer({ fence, bootstrapToken: Redacted.make("bootstrap") })
    return Effect.gen(function* () {
      persisted = yield* run(
        Effect.gen(function* () {
          const runtime = yield* ExecutorRuntime
          expect(yield* runtime.hasSession).toBe(false)
          expect((yield* runtime.hello).fence).toEqual(fence)
          yield* runtime.welcome({
            version: 1,
            fence,
            sessionToken: "session-secret",
            leaseExpiresAt: 10_000,
            heartbeatIntervalMillis: 20_000,
            cursor: { sequence: 1, value: "executor:1" },
          })
          expect(yield* runtime.hasSession).toBe(true)
          const heartbeat = yield* runtime.heartbeat({ sequence: 2, value: "executor:2" })
          expect(heartbeat.cursor).toEqual({ sequence: 2, value: "executor:2" })
          expect((yield* runtime.persistedSession).cursor).toEqual({ sequence: 1, value: "executor:1" })
          yield* runtime.receipt({
            version: 1,
            fence,
            leaseExpiresAt: 20_000,
            cursor: { sequence: 2, value: "executor:2" },
          })
          return yield* runtime.persistedSession
        }),
        first,
      )
      const restored = layer({
        fence,
        bootstrapToken: Redacted.make("consumed-bootstrap"),
        restoredSession: persisted,
      })
      yield* run(
        Effect.gen(function* () {
          const runtime = yield* ExecutorRuntime
          expect(yield* runtime.hasSession).toBe(true)
          expect((yield* runtime.reconnect).sessionToken).toBe("session-secret")
          yield* runtime.reconnected({
            version: 1,
            fence,
            leaseExpiresAt: 30_000,
            heartbeatIntervalMillis: 20_000,
            cursor: { sequence: 2, value: "executor:2" },
          })
          expect(yield* runtime.cursor).toEqual({ sequence: 2, value: "executor:2" })
          expect((yield* Effect.flip(runtime.hello)).kind).toBe("phase")
          expect(
            (yield* Effect.flip(
              runtime.reconnected({
                version: 1,
                fence,
                leaseExpiresAt: 40_000,
                heartbeatIntervalMillis: 20_000,
                cursor: { sequence: 1, value: "executor:1" },
              }),
            )).kind,
          ).toBe("cursor")
          expect((yield* Effect.flip(runtime.heartbeat({ sequence: 1, value: "executor:1" }))).kind).toBe("cursor")
          expect(
            (yield* Effect.flip(
              runtime.receipt({
                version: 1,
                fence,
                leaseExpiresAt: 40_000,
                cursor: { sequence: 2, value: "conflict" },
              }),
            )).kind,
          ).toBe("cursor")
        }),
        restored,
      )
    })
  })

  it.effect("fences a welcome from another generation or provider instance", () =>
    run(
      Effect.gen(function* () {
        const runtime = yield* ExecutorRuntime
        const error = yield* Effect.flip(
          runtime.welcome({
            version: 1,
            fence: { ...fence, generation: 4 },
            sessionToken: "session-secret",
            leaseExpiresAt: 10_000,
            heartbeatIntervalMillis: 20_000,
            cursor: { sequence: 0, value: "" },
          }),
        )
        expect(error.kind).toBe("fenced")
      }),
      layer({ fence, bootstrapToken: Redacted.make("bootstrap") }),
    ),
  )
})
