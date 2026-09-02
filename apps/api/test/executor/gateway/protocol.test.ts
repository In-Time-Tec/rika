import { describe, expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { Effect, Fiber } from "effect"
import { GatewayTestHarness } from "./fixture"

const {
  encode,
  decode,
  workspaceCapabilities,
  environmentDigest,
  makeGateway,
  fence,
  access,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: protocol-fencing", () => {
  it.effect("accepts a checkpoint-only quiesce barrier", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: true, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const barrier = yield* Effect.forkChild(gateway.quiesce("assignment-1"))
      yield* Effect.yieldNow
      const request = decode(target.sent.at(-1)!)
      if (request._tag !== "Quiesce") return yield* Effect.die("quiesce request missing")
      const checkpoint = {
        version: 1 as const,
        checkpointId: "checkpoint-ready",
        archive: { content: "eA==", contentDigest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 },
        cursor: { sequence: 0, value: "" },
      }
      yield* gateway.receive(
        target,
        encode({ _tag: "ExecutorQuiesced", access, requestId: request.requestId, checkpoint }),
      )
      expect(yield* Fiber.join(barrier)).toMatchObject({ checkpoint })
      expect(target.closed).toEqual([])
    }),
  )

  it.effect("treats setup cache storage faults as a safe miss without fencing the executor", () =>
    Effect.gen(function* () {
      const target = socket()
      const cacheFailure = ControllerError.make({ kind: "checkpoint", message: "cache unavailable" })
      const gateway = yield* makeGateway(
        controller({
          loadSetupCache: () => Effect.fail(cacheFailure),
          storeSetupCache: () => Effect.fail(cacheFailure),
        }),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: true, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      const key = {
        ownerId: "owner-1",
        repository: {
          repositoryId: "repository-1",
          owner: "In-Time-Tec",
          name: "rika",
          commitSha: "a".repeat(40),
        },
        setupHookDigest: `sha256:${"b".repeat(64)}`,
        templateBuildId: "build-1",
        environmentDigest,
      }
      yield* gateway.receive(target, encode({ _tag: "SetupCacheLookup", access, requestId: "cache-lookup", key }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "SetupCacheProposed",
          access,
          requestId: "cache-store",
          key,
          archive: { content: "eA==", contentDigest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 },
        }),
      )
      expect(decode(target.sent.at(-2)!)).toEqual({
        _tag: "SetupCacheResult",
        requestId: "cache-lookup",
        archive: null,
      })
      expect(decode(target.sent.at(-1)!)).toEqual({ _tag: "SetupCacheAccepted", requestId: "cache-store" })
      expect(target.closed).toEqual([])
    }),
  )

  it.effect("closes malformed frames", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(target, "not json")
      expect(target.sent).toEqual([])
      expect(target.closed).toEqual([[1007, "undecodable unknown frame; peer protocol does not match"]])
    }),
  )

  it.effect("fences and closes unauthorized heartbeats", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(
        controller({
          heartbeat: () => Effect.fail(ControllerError.make({ kind: "authentication", message: "invalid session" })),
        }),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHeartbeat",
          heartbeat: { version: 1, access, cursor: { sequence: 1, value: "cursor-1" } },
        }),
      )
      expect(decode(target.sent[0]!)).toEqual({ _tag: "Fenced", fence, message: "invalid session" })
      expect(target.closed).toEqual([[1008, "authentication"]])
    }),
  )
})
