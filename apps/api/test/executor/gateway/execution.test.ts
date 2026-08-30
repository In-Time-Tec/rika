import { describe, expect, it } from "@effect/vitest"
import { CellTerminalSettlementGraceMillis } from "@rika/remote-execution/cells"
import { Effect, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { cancelledResponse } from "../../../src/executor/gateway"
import { GatewayTestHarness } from "./fixture"

const {
  encode,
  decode,
  encodeUnknown,
  workspaceCapabilities,
  lifecycleStore,
  readyPreparation,
  environmentDigest,
  makeGateway,
  bindings,
  fence,
  access,
  cellIdentity,
  attribution,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: deadlines-settlement", () => {
  it.effect("dispatches a cell once and retains its first operational window", () =>
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
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      const repeated = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          admittedAt: "2026-08-25T00:00:00.000Z",
          deadlineAt: "2026-08-25T00:02:00.000Z",
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      const dispatched = target.sent.map((message) => decode(message)).find((message) => message._tag === "CellExecute")
      expect(dispatched).toMatchObject({
        _tag: "CellExecute",
        request: {
          access,
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo hosted-mvp",
          bindings: bindings.manifest,
        },
      })
      const response = { _tag: "Success" as const, result: { stdout: "hosted-mvp\n", stderr: "", exitCode: 0 } }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-1"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-1"), cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Terminal",
            attribution: attribution("operation-1"),
            cursor: 3,
            outcome: "completed",
            response,
          },
        }),
      )
      expect(
        target.sent.map((message) => decode(message)).find((message) => message._tag === "CellTerminalReceipt"),
      ).toEqual({
        _tag: "CellTerminalReceipt",
        access,
        operationKey: "operation-1",
        attempt: 0,
        cursor: 3,
      })
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-1",
          attempt: 0,
          response,
        }),
      )
      expect(yield* Fiber.join(running)).toEqual({
        access,
        response,
        outcome: "completed",
      })
      expect(yield* Fiber.join(repeated)).toEqual({
        access,
        response,
        outcome: "completed",
      })
      expect(
        target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellExecute"),
      ).toHaveLength(1)
    }),
  )

  it.effect("replays a durable Orb receipt and redelivers cancellation after API replacement", () =>
    Effect.gen(function* () {
      const retained = lifecycleStore()
      const firstSocket = socket()
      const first = yield* makeGateway(controller(), undefined, undefined, readyPreparation, retained)
      yield* first.receive(
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
      yield* workspaceReady(first, firstSocket)
      const running = yield* Effect.forkChild(
        first.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-api-restart",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "wait for api restart",
        }),
      )
      yield* Effect.yieldNow
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-api-restart"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-api-restart"), cursor: 2 },
      ])
        yield* first.receive(firstSocket, encode({ _tag: "CellLifecycle", access, frame }))
      yield* Fiber.interrupt(running)
      expect(firstSocket.sent.map((message) => decode(message)).some((message) => message._tag === "CellCancel")).toBe(
        false,
      )

      const restartedSocket = socket()
      const restarted = yield* makeGateway(controller(), undefined, undefined, readyPreparation, retained)
      yield* restarted.receive(
        restartedSocket,
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
      yield* workspaceReady(restarted, restartedSocket)
      expect(
        restartedSocket.sent
          .map((message) => decode(message))
          .find((message) => message._tag === "CellReplay" && message.operationKey === "operation-api-restart"),
      ).toEqual({
        _tag: "CellReplay",
        access,
        operationKey: "operation-api-restart",
        attempt: 0,
        afterCursor: 2,
      })
      const cancelling = yield* Effect.forkChild(
        restarted.cancel({
          assignmentId: "assignment-1",
          operationKey: "operation-api-restart",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "wait for api restart",
        }),
      )
      yield* Effect.yieldNow
      expect(
        restartedSocket.sent
          .map((message) => decode(message))
          .find((message) => message._tag === "CellCancel" && message.operationKey === "operation-api-restart"),
      ).toEqual({
        _tag: "CellCancel",
        access,
        operationKey: "operation-api-restart",
        attempt: 0,
      })
      yield* restarted.receive(
        restartedSocket,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Terminal",
            attribution: attribution("operation-api-restart"),
            cursor: 3,
            outcome: "cancelled",
            response: cancelledResponse,
          },
        }),
      )
      yield* TestClock.adjust("100 millis")
      expect(yield* Fiber.join(cancelling)).toEqual({ response: cancelledResponse, outcome: "cancelled" })
    }),
  )

  it.effect("returns the executor terminal that settles after the execution deadline", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
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
        observed(
          gateway.execute({
            assignmentId: "assignment-1",
            operationKey: "operation-deadline",
            workspaceId: "workspace-1",
            sessionId: "thread-1",
            ...cellIdentity,
            deadlineAt: "1970-01-01T00:00:01.000Z",
            code: "wait forever",
          }),
        ),
      )
      yield* Effect.yieldNow
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-deadline"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-deadline"), cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* TestClock.adjust("1 second")
      expect(running.pollUnsafe()).toBeUndefined()
      expect(
        target.sent
          .map((message) => decode(message))
          .some((message) => message._tag === "CellCancel" && message.operationKey === "operation-deadline"),
      ).toBe(false)

      const cancelled = {
        _tag: "DomainFailure" as const,
        failure: { kind: "cancelled", message: "Cell operation was cancelled" },
      }
      yield* TestClock.adjust("100 millis")
      yield* observed(
        gateway.receive(
          target,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: {
              _tag: "Terminal",
              attribution: attribution("operation-deadline"),
              cursor: 3,
              outcome: "cancelled",
              response: cancelled,
            },
          }),
        ),
      )
      yield* TestClock.adjust("100 millis")
      expect(yield* Fiber.join(running)).toEqual({ response: cancelled, outcome: "cancelled" })
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-deadline",
          attempt: 0,
          response: cancelled,
        }),
      )
      expect(target.closed).toEqual([])
      const renderedObservability = encodeUnknown(observability)
      expect(renderedObservability.match(/hosted\.terminal\.unknown/g)).toBeNull()
      expect(renderedObservability.match(/hosted\.terminal\.interrupted/g)).toHaveLength(1)
      const deadlineAcknowledgements = target.sent
        .map((message) => decode(message))
        .filter(
          (message) =>
            (message._tag === "CellTerminalReceipt" || message._tag === "CellTerminalSuperseded") &&
            message.operationKey === "operation-deadline",
        )
      expect(deadlineAcknowledgements).toEqual([
        {
          _tag: "CellTerminalReceipt",
          access,
          operationKey: "operation-deadline",
          attempt: 0,
          cursor: 3,
        },
      ])

      const next = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-after-deadline",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      const response = { _tag: "Success" as const, result: 42 }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-after-deadline"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-after-deadline"), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution("operation-after-deadline"),
          cursor: 3,
          outcome: "completed" as const,
          response,
        },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-after-deadline",
          attempt: 0,
          response,
        }),
      )
      expect(yield* Fiber.join(next)).toEqual({ access, response, outcome: "completed" })
      expect(target.closed).toEqual([])
    }),
  )

  it.effect("returns unknown after settlement grace and preserves a later executor terminal", () =>
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
      const input = {
        assignmentId: "assignment-1",
        operationKey: "operation-after-settlement-grace",
        workspaceId: "workspace-1",
        sessionId: "thread-1",
        ...cellIdentity,
        deadlineAt: "1970-01-01T00:00:01.000Z",
        code: "wait beyond settlement grace",
      }
      const running = yield* Effect.forkChild(gateway.execute(input))
      yield* Effect.yieldNow
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution(input.operationKey), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution(input.operationKey), cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* TestClock.adjust("1 second")
      expect(running.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(CellTerminalSettlementGraceMillis)
      expect(yield* Fiber.join(running)).toEqual({
        response: {
          _tag: "DomainFailure",
          failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
        },
        outcome: "unknown",
      })
      expect(
        target.sent
          .map((message) => decode(message))
          .filter((message) => message._tag === "CellCancel" && message.operationKey === input.operationKey),
      ).toHaveLength(1)

      const cancelled = {
        _tag: "DomainFailure" as const,
        failure: { kind: "cancelled", message: "Cell operation was cancelled" },
      }
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Terminal",
            attribution: attribution(input.operationKey),
            cursor: 3,
            outcome: "cancelled",
            response: cancelled,
          },
        }),
      )
      expect(yield* gateway.execute(input)).toEqual({ response: cancelled, outcome: "cancelled" })
      expect(target.closed).toEqual([])
    }),
  )
})
