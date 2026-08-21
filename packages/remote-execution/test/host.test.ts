import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Redacted, Semaphore, Stream } from "effect"
import { sessionStore, testing } from "../src/host"
import { Manager as PtyManager } from "../src/pty"
import { RepositoryServices } from "../src/repository-services"
import { Runtime, layer as runtimeLayer } from "../src/runtime"
import type { Fence, SessionWire } from "../src/protocol"
import { WorkspaceFiles } from "../src/workspace-files"
import { provideLayer } from "./support/layer"
import { workspaceCapabilities } from "./support/workspace-capabilities"

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
          workspaceCapabilities,
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

  it.effect("rejects a stale assignment fence before invoking the PTY process driver", () => {
    let creates = 0
    const pty = Layer.succeed(
      PtyManager,
      PtyManager.of({
        create: () => Effect.sync(() => creates++).pipe(Effect.andThen(Effect.die("unexpected create"))),
        input: () => Effect.die("unexpected input"),
        resize: () => Effect.die("unexpected resize"),
        disconnect: () => Effect.die("unexpected disconnect"),
        disconnectAll: Effect.void,
        reconnect: () => Effect.die("unexpected reconnect"),
        terminate: () => Effect.die("unexpected terminate"),
        recordOutput: () => Effect.die("unexpected output"),
        cursor: Effect.succeed(0),
        events: Stream.empty,
      }),
    )
    const runtime = runtimeLayer({
      fence,
      bootstrapToken: Redacted.make("consumed"),
      templateBuildId: "build-1",
      capabilities: { cells: true, checkpoints: false, pty: true },
      workspaceCapabilities,
      cursors: { command: 0, event: 0, pty: 0 },
      latestCheckpointId: null,
      restoredSession: session,
    })
    return Effect.gen(function* () {
      const delivery = yield* Semaphore.make(1)
      const error = yield* Effect.flip(
        testing.dispatchPty(
          {
            _tag: "PtyCreate",
            fence: { ...fence, assignmentGeneration: 2 },
            request: { ptyId: "pty-1", command: "bash", cwd: "/workspace", cols: 80, rows: 24 },
          },
          () => Effect.void,
          delivery,
        ),
      )
      expect(error.message).toBe("PTY request has a stale executor fence")
      expect(creates).toBe(0)
    }).pipe(provideLayer(Layer.merge(runtime, pty)))
  })

  it.effect("rejects stale Workspace requests before file or service access", () => {
    let calls = 0
    const runtime = runtimeLayer({
      fence,
      bootstrapToken: Redacted.make("consumed"),
      templateBuildId: "build-1",
      capabilities: { cells: true, checkpoints: false, pty: true },
      workspaceCapabilities,
      cursors: { command: 0, event: 0, pty: 0 },
      latestCheckpointId: null,
      restoredSession: session,
    })
    const workspace = Layer.merge(
      Layer.succeed(
        WorkspaceFiles,
        WorkspaceFiles.of({
          inspect: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.die("unexpected inspection"))),
        }),
      ),
      Layer.succeed(
        RepositoryServices,
        RepositoryServices.of({
          ensure: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.die("unexpected ensure"))),
          stop: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.die("unexpected stop"))),
          resume: Effect.void,
        }),
      ),
    )
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        testing.dispatchWorkspace(
          {
            _tag: "WorkspaceRequest",
            fence: { ...fence, assignmentGeneration: 2 },
            request: {
              _tag: "WorkspaceFileInspect",
              requestId: "request-1",
              path: "src/main.ts",
              maximumBytes: 1024,
            },
          },
          () => Effect.void,
        ),
      )
      expect(error.message).toBe("Workspace request has a stale executor fence")
      expect(calls).toBe(0)
    }).pipe(provideLayer(Layer.merge(runtime, workspace)))
  })
})
