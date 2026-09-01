import { describe, expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { Effect, Fiber } from "effect"
import { GatewayTestHarness } from "../../fixture"

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

describe("executor gateway: session-resume-dispatch", () => {
  it.effect("reports a registered executor inactive when its durable authority is revoked", () =>
    Effect.gen(function* () {
      const target = socket()
      let failure: ControllerError | undefined
      const gateway = yield* makeGateway(
        controller({
          validateAccess: () => (failure === undefined ? Effect.void : Effect.fail(failure)),
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
            capabilities: { nativeTools: true, checkpoints: false, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      expect(yield* gateway.active(target)).toBe(true)
      failure = ControllerError.make({ kind: "repository", message: "temporarily unavailable" })
      expect(yield* gateway.active(target)).toBe(true)
      failure = ControllerError.make({ kind: "fenced", message: "revoked" })
      expect(yield* gateway.active(target)).toBe(false)
    }),
  )

  it.effect("correlates Workspace requests and replays them on a resumed executor session", () =>
    Effect.gen(function* () {
      const first = socket()
      const resumed = socket()
      const gateway = yield* makeGateway(
        controller({
          reconnect: () =>
            Effect.succeed({
              version: 1,
              fence,
              leaseEpoch: 2,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 1, value: "cursor-1" },
            }),
        }),
      )
      yield* gateway.receive(
        first,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: false, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, first)
      const request = {
        _tag: "WorkspaceFileInspect" as const,
        requestId: "inspect-1",
        path: "src/main.ts",
        maximumBytes: 1024,
      }
      const pending = yield* Effect.forkChild(gateway.workspace("assignment-1", request))
      yield* Effect.yieldNow
      expect(
        first.sent.map((message) => decode(message)).find((message) => message._tag === "WorkspaceRequest"),
      ).toEqual({
        _tag: "WorkspaceRequest",
        fence,
        request,
      })

      yield* gateway.disconnected(first)
      yield* gateway.receive(resumed, encode({ _tag: "ExecutorReconnect", access }))
      const resumedAccess = { ...access, leaseEpoch: 2 }
      yield* workspaceReady(gateway, resumed, resumedAccess)
      expect(
        resumed.sent.map((message) => decode(message)).find((message) => message._tag === "WorkspaceRequest"),
      ).toEqual({
        _tag: "WorkspaceRequest",
        fence,
        request,
      })
      const response = {
        _tag: "WorkspaceFileContent" as const,
        requestId: "inspect-1",
        path: "src/main.ts",
        sizeBytes: 2,
        contentBase64: "e30=",
      }
      yield* gateway.receive(resumed, encode({ _tag: "WorkspaceResponse", access: resumedAccess, response }))
      expect(yield* Fiber.join(pending)).toEqual(response)
    }),
  )

  it.effect("rejects an acknowledged Hello replay without displacing the live socket", () =>
    Effect.gen(function* () {
      const first = socket()
      const replay = socket()
      const gateway = yield* makeGateway(controller())
      const hello = encode({
        _tag: "ExecutorHello",
        lifecycle: "fresh",
        environmentDigest,
        hello: {
          minimumVersion: 1,
          maximumVersion: 1,
          fence,
          templateBuildId: "build-1",
          capabilities: { nativeTools: true, checkpoints: false, pty: false },
          workspaceCapabilities,
          cursors: { command: 0, event: 0, pty: 0 },
          latestCheckpointId: null,
          bootstrapToken: "bootstrap-token",
        },
      })
      yield* gateway.receive(first, hello)
      yield* gateway.receive(replay, hello)
      expect(first.closed).toEqual([])
      expect(replay.sent).toEqual([])
      expect(replay.closed).toEqual([[1008, "duplicate"]])
    }),
  )

  it.effect("replaces authority instead of accepting a stale reconnect when no live session exists", () =>
    Effect.gen(function* () {
      const target = socket()
      let replacements = 0
      const gateway = yield* makeGateway(
        controller({
          reconnect: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "stale reconnect" })),
          replace: () =>
            Effect.sync(() => {
              replacements += 1
              return {
                assignmentId: "assignment-1",
                threadId: "thread-1",
                generation: 2,
                templateBuildId: "build-1",
                sandboxId: "sandbox-2",
                state: "provisioning" as const,
                cursor: { sequence: 0, value: "" },
              }
            }),
        }),
      )
      yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
      expect(replacements).toBe(1)
      expect(decode(target.sent[0]!)).toEqual({ _tag: "Fenced", fence, message: "stale reconnect" })
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )

  it.effect("does not replace a provisioning resume when its persisted reconnect is fenced", () =>
    Effect.gen(function* () {
      const target = socket()
      let replacements = 0
      const gateway = yield* makeGateway(
        controller({
          reconnect: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "resume in progress" })),
          validateAccess: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "not active" })),
          replace: () =>
            Effect.sync(() => {
              replacements += 1
              return {
                assignmentId: "assignment-1",
                threadId: "thread-1",
                generation: 2,
                templateBuildId: "build-1",
                sandboxId: "sandbox-2",
                state: "provisioning" as const,
                cursor: { sequence: 0, value: "" },
              }
            }),
        }),
      )
      yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
      expect(replacements).toBe(0)
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )
})
