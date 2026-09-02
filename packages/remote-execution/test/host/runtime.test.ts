import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Semaphore } from "effect"
import { mutableExecutionEnvironment } from "../../src/host/execution-environment"
import { Runtime, layer } from "../../src/host/runtime"
import { testing } from "../../src/host/service"
import type { Fence, IncomingMessage, ProtocolError, SessionWire } from "../../src/protocol/messages"
import { workspaceCapabilities } from "../support/workspace-capabilities"

type PhaseGrant = Extract<IncomingMessage, { readonly _tag: "PhaseEnvironmentGranted" }>

describe("hosted phase environment", () => {
  it.effect("replaces ambient native tool values and retains operation-scoped grants", () =>
    Effect.gen(function* () {
      const grants = yield* Ref.make(new Map<string, PhaseGrant>())
      const access = yield* Semaphore.make(1)
      const environment = mutableExecutionEnvironment()
      environment.replace({ SETUP_TOKEN: "setup-value" })
      yield* testing.applyPhaseGrant(
        {
          _tag: "PhaseEnvironmentGranted",
          phase: "runtime",
          digest: `sha256:${"b".repeat(64)}`,
          operationKey: null,
          values: { RUNTIME_TOKEN: "runtime-value" },
          redactedNames: ["RUNTIME_TOKEN"],
        },
        grants,
        environment.values,
        access,
      )
      expect({ ...environment.values }).toEqual({ RUNTIME_TOKEN: "runtime-value" })
      const operation = {
        _tag: "PhaseEnvironmentGranted" as const,
        phase: "runtime" as const,
        digest: `sha256:${"c".repeat(64)}`,
        operationKey: "operation-1",
        values: { OPERATION_TOKEN: "operation-value" },
        redactedNames: ["OPERATION_TOKEN"],
      }
      yield* testing.applyPhaseGrant(operation, grants, environment.values, access)
      expect((yield* Ref.get(grants)).get("operation-1")).toEqual(operation)
      expect({ ...environment.values }).toEqual({ RUNTIME_TOKEN: "runtime-value" })
    }),
  )
})

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
  capabilities: { nativeTools: true, checkpoints: true, pty: true },
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
