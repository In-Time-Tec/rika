import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { rikaHostedExecutorOperations } from "@rika/product-store/database-schema"
import * as HostedPostgres from "@rika/product-store/layer"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import { CellTerminalSettlementGraceMillis } from "@rika/remote-execution/cells"
import { NestedOperation, ToolContext } from "tenetkit"
import { HostModules } from "tenetkit/repl"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import type { BindingAuthority } from "../../../src/executor/gateway"
import {
  access,
  assignmentId,
  authority,
  bindingRequestDigest,
  cancelledResponse,
  cellRequest,
  code,
  decode,
  encode,
  emptyCellContext,
  live,
  makeRunnerGateway,
  operationAttribution,
  operationDigest,
  persistTerminal,
  response,
  socket,
  threadId,
} from "./harness"
import { eventually, isolated, seed } from "./database.harness"

it.effect.skipIf(!live)("settles active Local Runner machine work before accepting a cancelled Cell terminal", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-cancelled-machine"
        yield* seed(databaseClient, operationKey, { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        const running = yield* Effect.forkChild(gateway.execute(cellRequest(operationKey)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey),
        )
        const machine = yield* Effect.forkChild(
          gateway.machine(assignmentId, operationKey, 0, {
            _tag: "CodingTool",
            request: { _tag: "Bash", command: "sleep 30" },
          }),
        )
        const machineRequest = yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
        )
        if (machineRequest._tag !== "MachineExecute") return yield* Effect.die("machine request was not sent")

        for (const frame of [
          { _tag: "Accepted" as const, attribution: operationAttribution(operationKey), cursor: 1 },
          { _tag: "Started" as const, attribution: operationAttribution(operationKey), cursor: 2 },
        ])
          yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
        yield* Fiber.interrupt(running)
        const cancelling = yield* Effect.forkChild(gateway.cancel(cellRequest(operationKey)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
        )
        yield* gateway.receive(
          target,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: {
              _tag: "Terminal",
              attribution: operationAttribution(operationKey),
              cursor: 3,
              outcome: "cancelled",
              response: cancelledResponse,
            },
          }),
        )
        expect(machine.pollUnsafe()).toBeDefined()
        expect(yield* Fiber.join(machine)).toEqual({ _tag: "Cancelled" })
        expect(yield* Fiber.join(cancelling)).toEqual({
          access,
          response: cancelledResponse,
          outcome: "cancelled",
          eventPersisted: true,
        })

        const nextOperationKey = "operation-after-cancelled-machine"
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedExecutorOperations).values({
            assignmentId,
            ownerId: "organization-owner-local-gateway",
            operationKey: nextOperationKey,
            requestDigest: operationDigest(cellRequest(nextOperationKey)),
            workspaceId: "workspace-local-gateway",
            sessionId: assignmentId,
            threadId,
            turnId: "turn-local-gateway",
            runId: "run-local-gateway",
            rootRunId: "run-local-gateway",
            toolCallId: "call-local-gateway",
            code,
            attempt: 0,
            replayPolicy: "pure",
            deadlineAt: sql`'2999-01-01T00:00:00.000Z'::timestamptz`,
            state: "accepted",
            updatedAt: sql`transaction_timestamp()`,
          }),
        )
        const next = yield* Effect.forkChild(gateway.execute(cellRequest(nextOperationKey)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellExecute" && message.request.operationKey === nextOperationKey),
        )
        const nextMachine = yield* Effect.forkChild(
          gateway.machine(assignmentId, nextOperationKey, 0, {
            _tag: "ProcessStop",
            processId: "process-after-cancel",
          }),
        )
        const nextMachineRequest = yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "MachineExecute" && message.operationKey === nextOperationKey),
        )
        if (nextMachineRequest._tag !== "MachineExecute") return yield* Effect.die("next machine request was not sent")
        yield* gateway.receive(
          target,
          encode({
            _tag: "MachineResult",
            access,
            operationKey: nextOperationKey,
            attempt: 0,
            machineId: nextMachineRequest.machineId,
            requestDigest: nextMachineRequest.requestDigest,
            outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
          }),
        )
        expect(yield* Fiber.join(nextMachine)).toEqual({ _tag: "Success", value: { _tag: "ProcessStopped" } })
        yield* persistTerminal(gateway, target, access, nextOperationKey)
        expect(yield* Fiber.join(next)).toMatchObject({ response, outcome: "completed", eventPersisted: true })

        yield* gateway.receive(
          target,
          encode({
            _tag: "MachineResult",
            access,
            operationKey,
            attempt: 0,
            machineId: machineRequest.machineId,
            requestDigest: machineRequest.requestDigest,
            outcome: {
              _tag: "Success",
              value: { _tag: "CodingTool", result: { text: "late", truncated: false } },
            },
          }),
        )
        expect(target.closed).toEqual([])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("bounds reconnected binding and machine work by the parent deadline", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:01.000Z"
        const operationKey = "operation-machine-reconnect"
        const invocationStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const releaseCleanup = yield* Deferred.make<void>()
        const cleanupCompleted = yield* Deferred.make<void>()
        const signal = yield* Effect.abortSignal
        const bindingContext = Context.empty().pipe(
          Context.add(
            ToolContext.ToolContext,
            ToolContext.ToolContext.of({
              signal,
              emit: () => Effect.succeed(true),
              sessionId: assignmentId,
              runId: "run-local-gateway",
              toolCallId: "call-local-gateway",
              operationKey,
            }),
          ),
          Context.add(
            NestedOperation.Operations,
            NestedOperation.Operations.of({ run: (_request, operation) => operation }),
          ),
        )
        const registry = HostModules.HostModules.of({
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
        const operationBindings: BindingAuthority = {
          registry,
          context: Context.merge(bindingContext, emptyCellContext),
          manifest: { digest: "c".repeat(64), descriptors: registry.descriptors },
        }
        yield* seed(databaseClient, operationKey, { deadlineAt, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const first = socket()
        yield* gateway.receive(
          first,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        const running = yield* Effect.forkChild(
          gateway.execute({ ...cellRequest(operationKey, deadlineAt), bindings: operationBindings }),
        )
        yield* eventually(() =>
          first.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey),
        )
        const machine = yield* Effect.forkChild(
          gateway.machine(assignmentId, operationKey, 0, { _tag: "ProcessStop", processId: "process-1" }),
        )
        const machineRequest = yield* eventually(() =>
          first.sent.map((value) => decode(value)).find((message) => message._tag === "MachineExecute"),
        )
        if (machineRequest._tag !== "MachineExecute") return yield* Effect.die("machine request was not sent")

        yield* gateway.disconnected(first)
        const second = socket()
        yield* gateway.receive(
          second,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        expect(
          second.sent.map((value) => decode(value)).filter((message) => message._tag === "MachineExecute"),
        ).toEqual([
          expect.objectContaining({
            _tag: "MachineExecute",
            operationKey,
            machineId: machineRequest.machineId,
          }),
        ])

        const bindingRequest = {
          module: "workspace",
          operation: "read",
          input: { path: "README.md" },
          sessionId: assignmentId,
          cellId: "call-local-gateway",
        } as const
        const binding = yield* Effect.forkChild(
          gateway.receive(
            second,
            encode({
              _tag: "BindingInvoke",
              access,
              operationKey,
              attempt: 0,
              callId: `${operationKey}:binding:0`,
              requestDigest: bindingRequestDigest(bindingRequest),
              request: bindingRequest,
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
        expect(second.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")).toEqual(
          [],
        )
        yield* Deferred.succeed(releaseCleanup, undefined)
        yield* Deferred.await(cleanupCompleted)
        yield* Fiber.join(binding)
        yield* Fiber.join(advancing)
        yield* TestClock.adjust(CellTerminalSettlementGraceMillis)
        expect(yield* Fiber.join(running)).toMatchObject({ outcome: "unknown", eventPersisted: false })
        expect(second.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")).toEqual(
          [
            expect.objectContaining({
              _tag: "BindingResult",
              outcome: { _tag: "Unknown", message: "Cell binding outcome is unknown at the operation deadline" },
            }),
          ],
        )

        yield* gateway.disconnected(second)
        const third = socket()
        yield* gateway.receive(
          third,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        expect(third.sent.map((value) => decode(value)).filter((message) => message._tag === "MachineExecute")).toEqual(
          [],
        )
        yield* gateway.receive(
          third,
          encode({
            _tag: "MachineResult",
            access,
            operationKey,
            attempt: 0,
            machineId: machineRequest.machineId,
            requestDigest: machineRequest.requestDigest,
            outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
          }),
        )
        expect(third.closed).toEqual([])
        expect(third.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")).toEqual(
          [],
        )
      }),
    ),
  ),
)
