import { describe, expect, it } from "@effect/vitest"
import { ControllerError, type Interface as Controller } from "@rika/e2b-executor/controller"
import { ControllerMessage, HostMessage } from "@rika/remote-execution/protocol"
import { Effect, Fiber, Redacted, Schema } from "effect"
import { makeGateway, type Socket } from "../src/executor-gateway"

const encode = Schema.encodeSync(Schema.fromJsonString(HostMessage))
const decode = Schema.decodeSync(Schema.fromJsonString(ControllerMessage))

const fence = {
  target: "e2b" as const,
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1",
  processIncarnation: "process-1",
}

const access = { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session-token" }

const socket = () => {
  const sent: Array<string> = []
  const closed: Array<readonly [number | undefined, string | undefined]> = []
  return {
    sent,
    closed,
    send: (message: string) => sent.push(message),
    close: (code?: number, reason?: string) => closed.push([code, reason]),
  } as Socket & {
    readonly sent: Array<string>
    readonly closed: Array<readonly [number | undefined, string | undefined]>
  }
}

const controller = (overrides: Partial<Controller> = {}): Controller =>
  ({
    provision: () => Effect.die("unused"),
    replace: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    kill: () => Effect.die("unused"),
    hello: () =>
      Effect.succeed({
        version: 1,
        fence,
        sessionToken: Redacted.make("session-token"),
        leaseEpoch: 1,
        leaseExpiresAt: 100,
        heartbeatIntervalMillis: 20,
        cursor: { sequence: 0, value: "" },
      }),
    reconnect: () => Effect.die("unused"),
    heartbeat: () =>
      Effect.succeed({
        version: 1,
        fence,
        leaseEpoch: 1,
        leaseExpiresAt: 100,
        cursor: { sequence: 1, value: "cursor-1" },
      }),
    checkpoint: () => Effect.die("unused"),
    checkout: () => Effect.die("unused"),
    cleanupOrphans: Effect.die("unused"),
    ...overrides,
  }) as Controller

describe("executor gateway", () => {
  it.effect("decodes hello and writes the controller welcome", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: true, pty: true },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      expect(target.closed).toEqual([])
      expect(decode(target.sent[0]!)).toMatchObject({
        _tag: "ExecutorWelcome",
        welcome: { sessionToken: "session-token" },
      })
    }),
  )

  it.effect("dispatches a cell and correlates its result", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-1",
          workspace: "/workspace",
          sessionId: "thread-1",
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      expect(decode(target.sent[1]!)).toMatchObject({
        _tag: "CellExecute",
        request: {
          access,
          operationKey: "operation-1",
          workspace: "/workspace",
          sessionId: "thread-1",
          code: "echo hosted-mvp",
        },
      })
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          operationKey: "operation-1",
          response: { _tag: "Success", result: { stdout: "hosted-mvp\n", stderr: "", exitCode: 0 } },
        }),
      )
      expect(yield* Fiber.join(running)).toEqual({
        access,
        response: { _tag: "Success", result: { stdout: "hosted-mvp\n", stderr: "", exitCode: 0 } },
      })
    }),
  )

  it.effect("closes malformed frames", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(target, "not json")
      expect(target.sent).toEqual([])
      expect(target.closed).toEqual([[1007, "malformed"]])
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
})
