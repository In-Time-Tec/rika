import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { cancelledResponse } from "../../../src/executor/gateway"
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

describe("executor gateway: cancellation-quiescing", () => {
  it.effect("returns durable cancelled and unknown terminals without an executor session", () =>
    Effect.gen(function* () {
      const cancelled = {
        _tag: "DomainFailure" as const,
        failure: { kind: "cancelled", message: "Cell operation was cancelled" },
      }
      const unknown = {
        _tag: "DomainFailure" as const,
        failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
      }
      const gateway = yield* makeGateway(controller(), undefined, (_assignmentId, operationKey) => {
        if (operationKey === "operation-expired-before-dispatch") return Effect.succeed([])
        const response = operationKey === "operation-cancelled-replay" ? cancelled : unknown
        const outcome = operationKey === "operation-cancelled-replay" ? ("cancelled" as const) : ("unknown" as const)
        return Effect.succeed([
          { _tag: "Accepted" as const, attribution: attribution(operationKey), cursor: 1 },
          { _tag: "Started" as const, attribution: attribution(operationKey), cursor: 2 },
          { _tag: "Terminal" as const, attribution: attribution(operationKey), cursor: 3, outcome, response },
        ])
      })
      expect(
        yield* gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-cancelled-replay",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "cancelled",
        }),
      ).toEqual({ response: cancelled, outcome: "cancelled" })
      expect(
        yield* gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-unknown-replay",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "unknown",
        }),
      ).toEqual({ response: unknown, outcome: "unknown" })
      expect(
        yield* gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-expired-before-dispatch",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          deadlineAt: "1970-01-01T00:00:00.000Z",
          code: "expired",
        }),
      ).toEqual({
        response: {
          _tag: "DomainFailure",
          failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
        },
        outcome: "failed",
      })
    }),
  )

  it.effect("rejects excess output without acknowledging a terminal result", () =>
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-overflow",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      const identity = attribution("operation-overflow")
      for (const frame of [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      for (let index = 0; index < 17; index += 1)
        yield* gateway.receive(
          target,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: {
              _tag: "Output",
              attribution: identity,
              cursor: index + 3,
              stream: "stdout",
              text: "bounded",
              redacted: true,
              truncated: false,
            },
          }),
        )
      expect(target.closed.at(-1)).toEqual([1008, "fenced"])
      expect(
        target.sent.map((message) => decode(message)).some((message) => message._tag === "CellTerminalReceipt"),
      ).toBe(false)
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("sends an attributed cancellation for a running operation", () =>
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const request = {
        assignmentId: "assignment-1",
        operationKey: "operation-cancel",
        workspaceId: "workspace-1",
        sessionId: "thread-1",
        ...cellIdentity,
        code: "await never",
      }
      const running = yield* Effect.forkChild(gateway.execute(request))
      yield* Effect.yieldNow
      const { bindings: _bindings, ...operation } = request
      const cancelling = yield* Effect.forkChild(gateway.cancel(operation), { startImmediately: true })
      yield* Effect.yieldNow
      expect(decode(target.sent.at(-1)!)).toEqual({
        _tag: "CellCancel",
        access,
        operationKey: "operation-cancel",
        attempt: 0,
      })
      const identity = attribution("operation-cancel")
      for (const frame of [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: identity,
          cursor: 3,
          outcome: "cancelled" as const,
          response: cancelledResponse,
        },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-cancel",
          attempt: 0,
          response: cancelledResponse,
        }),
      )
      expect(yield* Fiber.join(cancelling)).toEqual({ access, response: cancelledResponse, outcome: "cancelled" })
      expect(yield* Fiber.join(running)).toEqual({ access, response: cancelledResponse, outcome: "cancelled" })
    }),
  )

  it.effect("terminalizes repeated cancellation before executor dispatch", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway(controller())
      const { bindings: _bindings, ...operation } = {
        assignmentId: "assignment-1",
        operationKey: "operation-cancel-accepted",
        workspaceId: "workspace-1",
        sessionId: "thread-1",
        ...cellIdentity,
        code: "mustNotRun()",
      }
      const first = yield* gateway.cancel(operation)
      const repeated = yield* gateway.cancel(operation)
      expect(first).toEqual({ response: cancelledResponse, outcome: "cancelled" })
      expect(repeated).toEqual(first)
    }),
  )

  it.effect("fences admission while quiescing and accepts only a matching operation barrier", () =>
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
            capabilities: { cells: true, checkpoints: true, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-quiesced",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "await never",
        }),
      )
      yield* Effect.yieldNow
      const barrier = yield* Effect.forkChild(gateway.quiesce("assignment-1"))
      yield* Effect.yieldNow
      const request = decode(target.sent.at(-1)!)
      expect(request).toMatchObject({ _tag: "Quiesce", fence })
      const rejected = yield* Effect.flip(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-after-quiesce",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo forbidden",
        }),
      )
      expect(rejected).toMatchObject({ kind: "fenced" })
      if (request._tag !== "Quiesce") return yield* Effect.die("quiesce request missing")
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorQuiesced",
          access,
          requestId: request.requestId,
          operations: [{ operationKey: "operation-quiesced", outcome: "unknown" }],
          checkpoint: {
            version: 1,
            checkpointId: "checkpoint-quiesced",
            archive: { content: "eA==", contentDigest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 },
            cursor: { sequence: 0, value: "" },
          },
        }),
      )
      expect(yield* Fiber.join(barrier)).toMatchObject({
        operations: [{ operationKey: "operation-quiesced", outcome: "unknown" }],
      })
      yield* Fiber.interrupt(running)
    }),
  )
})
