import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { Runtime, layer } from "../../../src/host/runtime"
import type { Fence, ProtocolError, SessionWire } from "../../../src/protocol/messages"
import { workspaceCapabilities } from "../../support/workspace-capabilities"

const fence: Fence = {
  target: "orb",
  assignmentId: "assignment-1",
  assignmentGeneration: 3,
  instanceId: "sandbox-3",
  executorId: "executor-3",
  processIncarnation: "process-3",
}

const options = {
  templateBuildId: "build-3",
  capabilities: { cells: true, checkpoints: true, pty: true },
  workspaceCapabilities,
  cursors: { command: 0, event: 0, pty: 0 },
  latestCheckpointId: null,
}

const run = <A, E>(effect: Effect.Effect<A, E, Runtime>, runtime: Layer.Layer<Runtime, ProtocolError>) =>
  Effect.scoped(Effect.flatMap(Layer.build(runtime), (context) => Effect.provide(effect, context)))

describe("Runtime", () => {
  it.effect("persists a resumable session and replays only from the controller-acknowledged cursor", () => {
    let persisted: SessionWire | undefined
    const first = layer({ fence, bootstrapToken: Redacted.make("bootstrap"), ...options })
    return Effect.gen(function* () {
      persisted = yield* run(
        Effect.gen(function* () {
          const runtime = yield* Runtime
          expect(yield* runtime.hasSession).toBe(false)
          expect((yield* runtime.hello).fence).toEqual(fence)
          yield* runtime.welcome({
            version: 1,
            fence,
            leaseEpoch: 1,
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
            leaseEpoch: 1,
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
        ...options,
        restoredSession: persisted,
      })
      yield* run(
        Effect.gen(function* () {
          const runtime = yield* Runtime
          expect(yield* runtime.hasSession).toBe(true)
          expect((yield* runtime.reconnect).sessionToken).toBe("session-secret")
          yield* runtime.reconnected({
            version: 1,
            fence,
            leaseEpoch: 2,
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
                leaseEpoch: 3,
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
                leaseEpoch: 2,
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
        const runtime = yield* Runtime
        const error = yield* Effect.flip(
          runtime.welcome({
            version: 1,
            fence: { ...fence, assignmentGeneration: 4 },
            leaseEpoch: 1,
            sessionToken: "session-secret",
            leaseExpiresAt: 10_000,
            heartbeatIntervalMillis: 20_000,
            cursor: { sequence: 0, value: "" },
          }),
        )
        expect(error.kind).toBe("fenced")
      }),
      layer({ fence, bootstrapToken: Redacted.make("bootstrap"), ...options }),
    ),
  )
})
