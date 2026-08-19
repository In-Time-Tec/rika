import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { sessionStore } from "../src/host"
import { Runtime, layer as runtimeLayer } from "../src/runtime"
import type { Fence, SessionWire } from "../src/protocol"

const fence: Fence = {
  target: "e2b",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1:process-1",
  processIncarnation: "process-1",
}

const session: SessionWire = {
  version: 1,
  fence,
  leaseEpoch: 1,
  sessionToken: "session-token",
  heartbeatIntervalMillis: 20_000,
  cursor: { sequence: 2, value: "executor:2" },
}

const withFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.scoped(Effect.flatMap(Layer.build(BunFileSystem.layer), (context) => Effect.provide(effect, context)))

const withRuntime = <A, E>(effect: Effect.Effect<A, E, Runtime>) =>
  Effect.scoped(
    Effect.flatMap(
      Layer.build(
        runtimeLayer({
          fence,
          bootstrapToken: Redacted.make("bootstrap"),
          templateBuildId: "build-1",
          capabilities: { cells: true, checkpoints: true, pty: true },
          cursors: { command: 0, event: 0, pty: 0 },
          latestCheckpointId: null,
          restoredSession: session,
        }),
      ),
      (context) => Effect.provide(effect, context),
    ),
  )

describe("executor host session state", () => {
  it.effect("stores an owner-only protocol session and restores it for reconnect", () =>
    withFileSystem(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-executor-state-" })
          const store = yield* sessionStore(directory)
          yield* store.save(session)
          expect(Option.getOrUndefined(yield* store.load)).toEqual(session)
          expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700)
          expect((yield* fileSystem.stat(`${directory}/session.json`)).mode & 0o777).toBe(0o600)
          expect(yield* withRuntime(Effect.flatMap(Runtime, (runtime) => runtime.reconnect))).toEqual({
            version: 1,
            fence,
            leaseEpoch: 1,
            sessionToken: "session-token",
          })
        }),
      ),
    ),
  )
})
