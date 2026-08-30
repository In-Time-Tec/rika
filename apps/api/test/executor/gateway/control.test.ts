import { describe, expect, it } from "@effect/vitest"
import { CellTerminalSettlementGraceMillis } from "@rika/remote-execution/cells"
import { NestedOperation, ToolContext } from "tenetkit"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { cancelledResponse } from "../../../src/executor/gateway"
import { GatewayTestHarness } from "./fixture"

const {
  encode,
  decode,
  bindingRequestDigest,
  workspaceCapabilities,
  environmentDigest,
  makeGateway,
  bindingAuthority,
  fence,
  access,
  cellIdentity,
  attribution,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: binding-deadlines", () => {
  it.effect("settles active machine work before accepting a cancelled Cell terminal", () =>
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
      const operationKey = "operation-cancelled-machine"
      const input = {
        assignmentId: "assignment-1",
        operationKey,
        workspaceId: "workspace-1",
        sessionId: "thread-1",
        ...cellIdentity,
        code: "wait for machine",
      }
      const running = yield* Effect.forkChild(gateway.execute(input))
      yield* Effect.yieldNow
      const machine = yield* Effect.forkChild(
        gateway.machine("assignment-1", operationKey, 0, {
          _tag: "CodingTool",
          request: { _tag: "Bash", command: "sleep 30" },
        }),
      )
      yield* Effect.yieldNow
      expect(
        target.sent
          .map((message) => decode(message))
          .some((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
      ).toBe(true)
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution(operationKey), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution(operationKey), cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* Fiber.interrupt(running)
      const cancelling = yield* Effect.forkChild(gateway.cancel(input))
      yield* Effect.yieldNow
      expect(
        target.sent
          .map((message) => decode(message))
          .some((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
      ).toBe(true)
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Terminal",
            attribution: attribution(operationKey),
            cursor: 3,
            outcome: "cancelled",
            response: cancelledResponse,
          },
        }),
      )
      expect(machine.pollUnsafe()).toBeDefined()
      expect(yield* Fiber.join(machine)).toEqual({ _tag: "Cancelled" })
      yield* gateway.receive(
        target,
        encode({ _tag: "CellResult", access, operationKey, attempt: 0, response: cancelledResponse }),
      )
      expect(yield* Fiber.join(cancelling)).toEqual({ access, response: cancelledResponse, outcome: "cancelled" })

      const nextOperationKey = "operation-after-cancelled-machine"
      const next = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: nextOperationKey,
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "continue",
        }),
      )
      yield* Effect.yieldNow
      const nextMachine = yield* Effect.forkChild(
        gateway.machine("assignment-1", nextOperationKey, 0, {
          _tag: "ProcessStop",
          processId: "process-after-cancel",
        }),
      )
      yield* Effect.yieldNow
      const nextRequest = target.sent
        .map((message) => decode(message))
        .findLast((message) => message._tag === "MachineExecute" && message.operationKey === nextOperationKey)
      if (nextRequest?._tag !== "MachineExecute") return yield* Effect.die("next machine request was not sent")
      yield* gateway.receive(
        target,
        encode({
          _tag: "MachineResult",
          access,
          operationKey: nextOperationKey,
          attempt: 0,
          machineId: nextRequest.machineId,
          requestDigest: nextRequest.requestDigest,
          outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
        }),
      )
      expect(yield* Fiber.join(nextMachine)).toEqual({ _tag: "Success", value: { _tag: "ProcessStopped" } })
      const nextResponse = { _tag: "Success" as const, result: 42 }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution(nextOperationKey), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution(nextOperationKey), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution(nextOperationKey),
          cursor: 3,
          outcome: "completed" as const,
          response: nextResponse,
        },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* gateway.receive(
        target,
        encode({ _tag: "CellResult", access, operationKey: nextOperationKey, attempt: 0, response: nextResponse }),
      )
      expect(yield* Fiber.join(next)).toEqual({ access, response: nextResponse, outcome: "completed" })
    }),
  )

  it.effect("bounds binding and machine children by the parent cell deadline", () =>
    Effect.gen(function* () {
      const invocationStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const cleanupCompleted = yield* Deferred.make<void>()
      const signal = yield* Effect.abortSignal
      const context = Context.empty().pipe(
        Context.add(
          ToolContext.ToolContext,
          ToolContext.ToolContext.of({
            signal,
            emit: () => Effect.void,
            sessionId: "thread-1",
            runId: "run-1",
            toolCallId: "call-1",
            operationKey: "operation-child-deadline",
          }),
        ),
        Context.add(
          NestedOperation.NestedOperations,
          NestedOperation.NestedOperations.of({ run: (_request, operation) => operation }),
        ),
      )
      const registry = HostBindingRegistry.HostBindingRegistry.of({
        descriptors: [{ module: "workspace", operations: ["read"] }],
        resolve: () => Effect.die("unused"),
        invoke: () =>
          Deferred.succeed(invocationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
                Effect.andThen(Deferred.succeed(cleanupCompleted, undefined)),
              ),
            ),
          ),
      })
      const authority = bindingAuthority(registry, context, "c".repeat(64))
      const target = socket()
      let reconnectLease = 1
      const gateway = yield* makeGateway(
        controller({
          reconnect: () =>
            Effect.succeed({
              version: 1,
              fence,
              leaseEpoch: ++reconnectLease,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 1, value: "cursor-1" },
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
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-child-deadline",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          deadlineAt: "1970-01-01T00:00:01.000Z",
          code: "wait for children",
          bindings: authority,
        }),
      )
      yield* Effect.yieldNow
      const request = {
        module: "workspace",
        operation: "read",
        input: { path: "README.md" },
        sessionId: "thread-1",
        cellId: "call-1",
      } as const
      const beforeBoundary = yield* Effect.forkChild(
        gateway.machine("assignment-1", "operation-child-deadline", 0, {
          _tag: "ProcessStop",
          processId: "process-before-boundary",
        }),
      )
      yield* Effect.yieldNow
      const beforeBoundaryRequest = target.sent
        .map((message) => decode(message))
        .findLast((message) => message._tag === "MachineExecute")
      if (beforeBoundaryRequest?._tag !== "MachineExecute")
        return yield* Effect.die("before-boundary machine request was not sent")
      yield* gateway.receive(
        target,
        encode({
          _tag: "MachineResult",
          access,
          operationKey: beforeBoundaryRequest.operationKey,
          attempt: beforeBoundaryRequest.attempt,
          machineId: beforeBoundaryRequest.machineId,
          requestDigest: beforeBoundaryRequest.requestDigest,
          outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
        }),
      )
      expect(yield* Fiber.join(beforeBoundary)).toEqual({ _tag: "Success", value: { _tag: "ProcessStopped" } })
      const machine = yield* Effect.forkChild(
        gateway.machine("assignment-1", "operation-child-deadline", 0, {
          _tag: "ProcessStop",
          processId: "process-at-boundary",
        }),
      )
      yield* Effect.yieldNow
      const machineRequest = target.sent
        .map((message) => decode(message))
        .findLast((message) => message._tag === "MachineExecute")
      if (machineRequest?._tag !== "MachineExecute") return yield* Effect.die("machine request was not sent")
      const firstResumed = socket()
      const firstResumedAccess = { ...access, leaseEpoch: 2 }
      yield* gateway.disconnected(target)
      yield* gateway.receive(firstResumed, encode({ _tag: "ExecutorReconnect", access }))
      yield* workspaceReady(gateway, firstResumed, firstResumedAccess)
      expect(
        firstResumed.sent.map((message) => decode(message)).filter((message) => message._tag === "MachineExecute"),
      ).toEqual([
        expect.objectContaining({
          _tag: "MachineExecute",
          operationKey: machineRequest.operationKey,
          machineId: machineRequest.machineId,
        }),
      ])
      const binding = yield* Effect.forkChild(
        gateway.receive(
          firstResumed,
          encode({
            _tag: "BindingInvoke",
            access: firstResumedAccess,
            operationKey: "operation-child-deadline",
            attempt: 0,
            callId: "operation-child-deadline:binding:0",
            requestDigest: bindingRequestDigest(request),
            request,
          }),
        ),
      )
      yield* Deferred.await(invocationStarted)
      const advancing = yield* Effect.forkChild(TestClock.adjust("1 second"))
      yield* Deferred.await(cleanupStarted)
      expect(yield* Fiber.join(machine)).toEqual({
        _tag: "Unknown",
        message: "Machine outcome is unknown at the operation deadline",
      })
      expect(running.pollUnsafe()).toBeUndefined()
      expect(binding.pollUnsafe()).toBeUndefined()
      expect(
        firstResumed.sent.map((message) => decode(message)).filter((message) => message._tag === "BindingResult"),
      ).toEqual([])
      expect((yield* Deferred.poll(releaseCleanup))._tag).toBe("None")
      yield* gateway.receive(
        firstResumed,
        encode({
          _tag: "MachineResult",
          access: firstResumedAccess,
          operationKey: machineRequest.operationKey,
          attempt: machineRequest.attempt,
          machineId: machineRequest.machineId,
          requestDigest: machineRequest.requestDigest,
          outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
        }),
      )
      expect(firstResumed.closed).toEqual([])
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Deferred.await(cleanupCompleted)
      yield* Fiber.join(binding)
      yield* Fiber.join(advancing)
      yield* TestClock.adjust(CellTerminalSettlementGraceMillis)
      expect(yield* Fiber.join(running)).toMatchObject({ outcome: "unknown" })
      expect(
        firstResumed.sent.map((message) => decode(message)).filter((message) => message._tag === "BindingResult"),
      ).toEqual([
        expect.objectContaining({
          _tag: "BindingResult",
          outcome: { _tag: "Unknown", message: "Cell binding outcome is unknown at the operation deadline" },
        }),
      ])

      const resumed = socket()
      const resumedAccess = { ...access, leaseEpoch: 3 }
      yield* gateway.disconnected(firstResumed)
      yield* gateway.receive(resumed, encode({ _tag: "ExecutorReconnect", access: firstResumedAccess }))
      yield* workspaceReady(gateway, resumed, resumedAccess)
      expect(
        resumed.sent.map((message) => decode(message)).filter((message) => message._tag === "MachineExecute"),
      ).toEqual([])

      const next = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-after-child-deadline",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      const nextResponse = { _tag: "Success" as const, result: 42 }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-after-child-deadline"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-after-child-deadline"), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution("operation-after-child-deadline"),
          cursor: 3,
          outcome: "completed" as const,
          response: nextResponse,
        },
      ])
        yield* gateway.receive(resumed, encode({ _tag: "CellLifecycle", access: resumedAccess, frame }))
      yield* gateway.receive(
        resumed,
        encode({
          _tag: "CellResult",
          access: resumedAccess,
          operationKey: "operation-after-child-deadline",
          attempt: 0,
          response: nextResponse,
        }),
      )
      expect(yield* Fiber.join(next)).toEqual({ access: resumedAccess, response: nextResponse, outcome: "completed" })
      expect(resumed.closed).toEqual([])
    }),
  )
})
