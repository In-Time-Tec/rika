import { describe, expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { Effect, Fiber, Redacted } from "effect"
import { GatewayTestHarness } from "./fixture"

const {
  encode,
  decode,
  workspaceCapabilities,
  environmentDigest,
  makeGateway,
  fence,
  access,
  cellIdentity,
  attribution,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: replacement-generation", () => {
  it.effect("fences and closes stale reconnects", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(
        controller({ reconnect: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "stale lease" })) }),
      )
      yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
      expect(decode(target.sent[0]!)).toEqual({ _tag: "Fenced", fence, message: "stale lease" })
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )

  it.effect("does not send a cell after the gateway observes an expired lease", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(
        controller({
          hello: () =>
            Effect.succeed({
              version: 1,
              fence,
              sessionToken: Redacted.make("session-token"),
              leaseEpoch: 1,
              leaseExpiresAt: 0,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 0, value: "" },
            }),
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const error = yield* Effect.flip(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "expired-operation",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo should-not-run",
        }),
      )
      expect(error.kind).toBe("fenced")
      expect(target.sent.map((message) => decode(message)).some((message) => message._tag === "CellExecute")).toBe(
        false,
      )
    }),
  )

  it.effect("redispatches pending cells to a replacement connection for the same executor", () =>
    Effect.gen(function* () {
      const firstSocket = socket()
      const replacementSocket = socket()
      const gateway = yield* makeGateway(
        controller({
          reconnect: () =>
            Effect.succeed({
              version: 1,
              fence,
              leaseEpoch: 2,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 0, value: "" },
            }),
        }),
      )
      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, firstSocket)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "replacement-operation",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      yield* gateway.receive(replacementSocket, encode({ _tag: "ExecutorReconnect", access }))
      expect(firstSocket.closed).toEqual([[1008, "fenced"]])
      const replacementAccess = { ...access, leaseEpoch: 2 }
      yield* workspaceReady(gateway, replacementSocket, replacementAccess)
      const replacementMessages = replacementSocket.sent.map((message) => decode(message))
      expect(
        replacementMessages.find(
          (message) => message._tag === "PhaseEnvironmentGranted" && message.operationKey === "replacement-operation",
        ),
      ).toMatchObject({
        _tag: "PhaseEnvironmentGranted",
        phase: "runtime",
        operationKey: "replacement-operation",
      })
      expect(replacementMessages.find((message) => message._tag === "CellExecute")).toMatchObject({
        _tag: "CellExecute",
        request: {
          access: replacementAccess,
          operationKey: "replacement-operation",
          attempt: 0,
          code: "echo hosted-mvp",
        },
      })
      expect(
        replacementMessages.some(
          (message) => message._tag === "CellReplay" && message.operationKey === "replacement-operation",
        ),
      ).toBe(false)
      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "replacement-operation",
          attempt: 0,
          response: { _tag: "Success", result: { stdout: "stale\n", stderr: "", exitCode: 0 } },
        }),
      )
      const response = { _tag: "Success" as const, result: { stdout: "fresh\n", stderr: "", exitCode: 0 } }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("replacement-operation"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("replacement-operation"), cursor: 2 },
      ])
        yield* gateway.receive(replacementSocket, encode({ _tag: "CellLifecycle", access: replacementAccess, frame }))
      yield* gateway.receive(
        replacementSocket,
        encode({
          _tag: "CellLifecycle",
          access: replacementAccess,
          frame: {
            _tag: "Terminal",
            attribution: attribution("replacement-operation"),
            cursor: 3,
            outcome: "completed",
            response,
          },
        }),
      )
      yield* gateway.receive(
        replacementSocket,
        encode({
          _tag: "CellResult",
          access: replacementAccess,
          operationKey: "replacement-operation",
          attempt: 0,
          response,
        }),
      )
      expect(yield* Fiber.join(running)).toEqual({ access: replacementAccess, response, outcome: "completed" })
    }),
  )

  it.effect("fences old-generation frames and dispatches cells only to the replacement sandbox", () =>
    Effect.gen(function* () {
      const firstSocket = socket()
      const replacementSocket = socket()
      const persisted: Array<unknown> = []
      let approvedGeneration = 1
      const replacementFence = {
        ...fence,
        assignmentGeneration: 2,
        instanceId: "sandbox-2",
        executorId: "executor-2",
        processIncarnation: "process-2",
      }
      const replacementAccess = {
        version: 1 as const,
        fence: replacementFence,
        leaseEpoch: 1,
        sessionToken: "replacement-session-token",
      }
      const gateway = yield* makeGateway(
        controller({
          hello: (input) =>
            Effect.succeed({
              version: 1,
              fence: input.fence,
              sessionToken: Redacted.make(
                input.fence.assignmentGeneration === 1 ? access.sessionToken : replacementAccess.sessionToken,
              ),
              leaseEpoch: 1,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 0, value: "" },
            }),
          validateAccess: (input) =>
            input.fence.assignmentGeneration === approvedGeneration
              ? Effect.void
              : Effect.fail(ControllerError.make({ kind: "fenced", message: "assignment generation is stale" })),
        }),
        (_access, frame) => Effect.sync(() => persisted.push(frame)).pipe(Effect.as({ _tag: "Appended" as const })),
      )
      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, firstSocket)

      approvedGeneration = 2
      yield* gateway.receive(
        replacementSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "replacement",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence: replacementFence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: true, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: "checkpoint-1",
            bootstrapToken: "replacement-bootstrap-token",
          },
        }),
      )
      expect(firstSocket.closed).toEqual([[1008, "fenced"]])
      yield* workspaceReady(gateway, replacementSocket, replacementAccess)

      const operationKey = "generation-replacement-operation"
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey,
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo replacement",
        }),
      )
      yield* Effect.yieldNow
      expect(firstSocket.sent.map((message) => decode(message)).some((message) => message._tag === "CellExecute")).toBe(
        false,
      )
      expect(
        replacementSocket.sent.map((message) => decode(message)).find((message) => message._tag === "CellExecute"),
      ).toMatchObject({ _tag: "CellExecute", request: { access: replacementAccess, operationKey } })

      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: { _tag: "Accepted", attribution: attribution(operationKey), cursor: 1 },
        }),
      )
      expect(persisted).toEqual([])

      const response = { _tag: "Success" as const, result: { stdout: "replacement\n", stderr: "", exitCode: 0 } }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution(operationKey), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution(operationKey), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution(operationKey),
          cursor: 3,
          outcome: "completed" as const,
          response,
        },
      ])
        yield* gateway.receive(replacementSocket, encode({ _tag: "CellLifecycle", access: replacementAccess, frame }))
      yield* gateway.receive(
        replacementSocket,
        encode({ _tag: "CellResult", access: replacementAccess, operationKey, attempt: 0, response }),
      )
      expect(yield* Fiber.join(running)).toEqual({ access: replacementAccess, response, outcome: "completed" })
      expect(persisted).toHaveLength(3)
    }),
  )
})
