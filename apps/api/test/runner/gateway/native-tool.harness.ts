import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { rikaHostedExecutorOperationFrames, rikaHostedExecutorOperations } from "@rika/product-store/database-schema"
import * as HostedPostgres from "@rika/product-store/layer"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import type { MachineOutcome } from "@rika/remote-execution/protocol"
import { eq } from "drizzle-orm"
import { Clock, DateTime, Effect, Fiber, Layer, Redacted } from "effect"
import { access, authority, decode, encode, live, makeRunnerGateway, socket, toolRequest } from "./harness"
import { eventually, isolated, operationState, seed, seedOperation } from "./database.harness"

const nativeResult = { text: "native result", truncated: false }
type Gateway = Effect.Success<ReturnType<typeof makeRunnerGateway>>
const connect = (gateway: Gateway) => {
  const target = socket()
  return gateway
    .receive(target, encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }))
    .pipe(Effect.as(target))
}
const machineDelivery = (target: ReturnType<typeof socket>, operationKey: string) =>
  eventually(() =>
    target.sent
      .map((value) => decode(value))
      .find((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
  )
const completeMachine = (
  gateway: Gateway,
  target: ReturnType<typeof socket>,
  delivery: Extract<ReturnType<typeof decode>, { readonly _tag: "MachineExecute" }>,
  outcome: MachineOutcome,
) =>
  gateway.receive(
    target,
    encode({
      _tag: "MachineResult",
      access,
      operationKey: delivery.operationKey,
      attempt: delivery.attempt,
      machineId: delivery.machineId,
      requestDigest: delivery.requestDigest,
      outcome,
    }),
  )

it.effect.skipIf(!live)("executes a native Runner tool directly", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-success"
        const request = toolRequest(operationKey)
        yield* seed(databaseClient, operationKey, { request, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = yield* connect(gateway)
        const running = yield* Effect.forkChild(gateway.execute(request))
        const delivery = yield* machineDelivery(target, operationKey)
        if (delivery._tag !== "MachineExecute") return yield* Effect.die("native machine request was not sent")
        expect(delivery).toMatchObject({ operationKey, attempt: 0 })
        expect(delivery.machineId).toMatch(/^[a-f0-9]{64}$/)
        yield* completeMachine(gateway, target, delivery, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: nativeResult },
        })
        expect(yield* Fiber.join(running)).toEqual({
          access,
          response: { _tag: "Success", result: nativeResult },
          outcome: "completed",
          eventPersisted: false,
        })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 0 }])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ kind: rikaHostedExecutorOperationFrames.kind })
              .from(rikaHostedExecutorOperationFrames)
              .where(eq(rikaHostedExecutorOperationFrames.operationKey, operationKey))
              .orderBy(rikaHostedExecutorOperationFrames.cursor),
          ),
        ).toEqual([{ kind: "Accepted" }, { kind: "Started" }, { kind: "Terminal" }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("scopes Runner machine receipts when provider tool-call ids repeat across Runs", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstRequest = {
          ...toolRequest("native-tool-collision-a"),
          runId: "run-collision-a",
          rootRunId: "run-collision-a",
          toolCallId: "reused-provider-call",
        }
        const secondRequest = {
          ...toolRequest("native-tool-collision-b"),
          runId: "run-collision-b",
          rootRunId: "run-collision-b",
          toolCallId: "reused-provider-call",
        }
        yield* seed(databaseClient, firstRequest.operationKey, { request: firstRequest, state: "accepted" })
        yield* seedOperation(databaseClient, secondRequest)
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = yield* connect(gateway)
        const first = yield* Effect.forkChild(gateway.execute(firstRequest))
        const second = yield* Effect.forkChild(gateway.execute(secondRequest))
        const firstDelivery = yield* machineDelivery(target, firstRequest.operationKey)
        const secondDelivery = yield* machineDelivery(target, secondRequest.operationKey)
        if (firstDelivery._tag !== "MachineExecute" || secondDelivery._tag !== "MachineExecute")
          return yield* Effect.die("native machine requests were not sent")
        expect(firstDelivery.machineId).toMatch(/^[a-f0-9]{64}$/)
        expect(secondDelivery.machineId).toMatch(/^[a-f0-9]{64}$/)
        expect(secondDelivery.machineId).not.toBe(firstDelivery.machineId)
        yield* completeMachine(gateway, target, firstDelivery, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: nativeResult },
        })
        yield* completeMachine(gateway, target, secondDelivery, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: nativeResult },
        })
        expect(yield* Fiber.join(first)).toMatchObject({ outcome: "completed" })
        expect(yield* Fiber.join(second)).toMatchObject({ outcome: "completed" })
      }),
    ),
  ),
)

it.effect.skipIf(!live)("retains and replays one native Runner machine call through the outer identity", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-retained"
        const request = toolRequest(operationKey)
        yield* seed(databaseClient, operationKey, { request, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const firstSocket = yield* connect(gateway)
        const first = yield* Effect.forkChild(gateway.execute(request))
        const delivery = yield* machineDelivery(firstSocket, operationKey)
        if (delivery._tag !== "MachineExecute") return yield* Effect.die("native machine request was not sent")
        const retained = yield* Effect.forkChild(gateway.execute(request))
        expect(
          firstSocket.sent
            .map((value) => decode(value))
            .filter((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
        ).toHaveLength(1)

        yield* gateway.disconnected(firstSocket)
        const replacement = yield* connect(gateway)
        const replay = yield* machineDelivery(replacement, operationKey)
        if (replay._tag !== "MachineExecute") return yield* Effect.die("native machine request was not replayed")
        expect(replay).toMatchObject({
          operationKey,
          attempt: request.attempt,
          machineId: delivery.machineId,
          requestDigest: delivery.requestDigest,
        })
        yield* completeMachine(gateway, replacement, replay, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: nativeResult },
        })
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(retained)])
        expect(results[0]).toEqual(results[1])
        expect(results[0]).toMatchObject({ outcome: "completed", eventPersisted: false })
      }),
    ),
  ),
)

it.effect.skipIf(!live)("fences a conflicting native Runner request under the same outer key", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-conflict"
        const request = toolRequest(operationKey)
        yield* seed(databaseClient, operationKey, { request, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = yield* connect(gateway)
        const running = yield* Effect.forkChild(gateway.execute(request))
        const delivery = yield* machineDelivery(target, operationKey)
        if (delivery._tag !== "MachineExecute") return yield* Effect.die("native machine request was not sent")
        const conflictRequest = {
          ...request,
          code: request.code.replace("README.md", "CONTEXT.md"),
          machineRequest: { _tag: "NativeTool" as const, request: { _tag: "Read" as const, path: "CONTEXT.md" } },
        }
        const conflict = yield* Effect.flip(gateway.execute(conflictRequest))
        expect(conflict).toMatchObject({ kind: "fenced" })
        expect(
          target.sent
            .map((value) => decode(value))
            .filter((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
        ).toHaveLength(1)
        yield* completeMachine(gateway, target, delivery, {
          _tag: "Success",
          value: { _tag: "NativeTool", result: nativeResult },
        })
        yield* Fiber.join(running)
      }),
    ),
  ),
)

it.effect.skipIf(!live)("cancels a direct native Runner tool with MachineCancel", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-cancelled"
        const request = toolRequest(operationKey)
        yield* seed(databaseClient, operationKey, { request, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = yield* connect(gateway)
        const running = yield* Effect.forkChild(gateway.execute(request))
        const delivery = yield* machineDelivery(target, operationKey)
        if (delivery._tag !== "MachineExecute") return yield* Effect.die("native machine request was not sent")
        const cancelling = yield* Effect.forkChild(gateway.cancel(request))
        expect(
          yield* eventually(() =>
            target.sent
              .map((value) => decode(value))
              .find((message) => message._tag === "MachineCancel" && message.operationKey === operationKey),
          ),
        ).toMatchObject({
          _tag: "MachineCancel",
          operationKey,
          attempt: request.attempt,
          machineId: delivery.machineId,
          requestDigest: delivery.requestDigest,
        })
        yield* completeMachine(gateway, target, delivery, { _tag: "Cancelled" })
        const cancelled = yield* Fiber.join(cancelling)
        expect(cancelled).toMatchObject({
          response: { _tag: "DomainFailure", failure: { kind: "cancelled" } },
          outcome: "cancelled",
          eventPersisted: false,
        })
        expect(yield* Fiber.join(running)).toEqual(cancelled)
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("reports disconnected Runner cancellation without deciding its durable outcome", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-cancel-disconnected"
        const deadlineAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 10_000))
        const request = toolRequest(operationKey, deadlineAt)
        yield* seed(databaseClient, operationKey, { request, state: "dispatched", deadlineAt })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* gateway.cancel(request).pipe(Effect.flip)).toMatchObject({ kind: "disconnected" })
        expect(yield* gateway.cancel(request).pipe(Effect.flip)).toMatchObject({ kind: "disconnected" })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("reports a lost Runner result deadline without deciding its durable outcome", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-lost-terminal"
        const deadlineAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 10_000))
        const request = toolRequest(operationKey, deadlineAt)
        yield* seed(databaseClient, operationKey, { request, state: "dispatched", deadlineAt })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* gateway.execute(request).pipe(Effect.flip)).toMatchObject({ kind: "timeout" })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])
        expect(yield* gateway.execute(request).pipe(Effect.flip)).toMatchObject({ kind: "timeout" })
      }),
    ),
  ),
)

it.effect.skipIf(!live)("leaves a stale Runner terminal frame for Generalist to resolve after restart", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-restart-terminal"
        const deadlineAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 10_000))
        const request = toolRequest(operationKey, deadlineAt)
        yield* seed(databaseClient, operationKey, { request, state: "dispatched", deadlineAt })
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedExecutorOperationFrames).values({
            assignmentId: request.assignmentId,
            operationKey,
            attempt: request.attempt,
            cursor: 3,
            kind: "Terminal",
            frame: {
              _tag: "Terminal",
              attribution: {
                operationKey,
                workspaceId: request.workspaceId,
                sessionId: request.sessionId,
                threadId: request.threadId,
                turnId: request.turnId,
                runId: request.runId,
                rootRunId: request.rootRunId,
                toolCallId: request.toolCallId,
                attempt: request.attempt,
              },
              cursor: 3,
              outcome: "completed",
              response: { _tag: "Success", result: nativeResult },
            },
          }),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* gateway.execute(request).pipe(Effect.flip)).toMatchObject({ kind: "timeout" })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("keeps a native Runner unknown outcome unknown during later cancellation", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-unknown"
        const request = toolRequest(operationKey)
        yield* seed(databaseClient, operationKey, { request, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = yield* connect(gateway)
        const running = yield* Effect.forkChild(gateway.execute(request))
        const delivery = yield* machineDelivery(target, operationKey)
        if (delivery._tag !== "MachineExecute") return yield* Effect.die("native machine request was not sent")
        yield* completeMachine(gateway, target, delivery, { _tag: "Unknown", message: "delivery uncertain" })
        const unknown = yield* Fiber.join(running)
        expect(unknown).toMatchObject({
          response: { _tag: "DomainFailure", failure: { kind: "unknown", message: "delivery uncertain" } },
          outcome: "unknown",
          eventPersisted: false,
        })
        expect(yield* gateway.cancel(request)).toEqual({
          response: unknown.response,
          outcome: "unknown",
          eventPersisted: false,
        })
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ state: rikaHostedExecutorOperations.state })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, operationKey)),
          ),
        ).toEqual([{ state: "unknown" }])
      }),
    ),
  ),
)
