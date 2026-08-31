import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { rikaHostedExecutorAssignments, rikaHostedExecutorOperations } from "@rika/product-store/database-schema"
import * as HostedPostgres from "@rika/product-store/layer"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import { CellTerminalSettlementGraceMillis } from "@rika/remote-execution/cells"
import { eq, sql } from "drizzle-orm"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import {
  access,
  assignmentId,
  authority,
  cellRequest,
  decode,
  encode,
  live,
  makeRunnerGateway,
  persistTerminal,
  response,
  socket,
} from "./harness"
import { isolated, operationState, pauseAssignment, seed } from "./database.harness"

it.effect.skipIf(!live)("accepts a retained completion after reconnect renews the assignment lease", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-renewed")
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ lastLeaseEpoch: 2, leaseEpoch: 2 })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority({ renewedLeaseEpoch: 2 })).pipe(Effect.provide(context))
        const target = socket()
        const renewed = { ...access, leaseEpoch: 2 }
        yield* gateway.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access: renewed }),
        )
        yield* persistTerminal(gateway, target, renewed, "operation-renewed")
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access: renewed,
            operationKey: "operation-renewed",
            attempt: 0,
            response,
          }),
        )
        expect(target.closed).toEqual([])
        expect(
          target.sent.map((value) => decode(value)).filter((message) => message._tag === "LocalCellReceipt"),
        ).toHaveLength(1)
        expect(yield* operationState(databaseClient, "operation-renewed")).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("rejects a conflicting completion after a durable result already exists", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-conflict")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        yield* persistTerminal(gateway, target, access, "operation-conflict")
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-conflict",
            attempt: 0,
            response,
          }),
        )
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-conflict",
            attempt: 0,
            response: { _tag: "Success", result: { stdout: "other", stderr: "", exitCode: 1 } },
          }),
        )
        expect(target.closed).toEqual([[1008, "fenced"]])
        expect(yield* operationState(databaseClient, "operation-conflict")).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("reports an overdue dispatch without replacing the Runner's terminal authority", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:01.000Z"
        yield* seed(databaseClient, "operation-overdue", { deadlineAt })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const left = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const right = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        yield* TestClock.adjust("1 second")
        const waiting = yield* Effect.forkChild(
          Effect.all(
            [
              left.execute(cellRequest("operation-overdue", deadlineAt)),
              right.execute(cellRequest("operation-overdue", deadlineAt)),
            ],
            { concurrency: 2 },
          ),
        )
        yield* TestClock.adjust(CellTerminalSettlementGraceMillis)
        const results = yield* Fiber.join(waiting)
        expect(results.map((result) => result.response)).toEqual([
          {
            _tag: "DomainFailure",
            failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
          },
          {
            _tag: "DomainFailure",
            failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
          },
        ])
        expect(results.map((result) => result.eventPersisted)).toEqual([false, false])
        expect(yield* operationState(databaseClient, "operation-overdue")).toEqual([{ state: "dispatched", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("does not infer an operation outcome from assignment lease expiry", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-expired-lease", { leaseExpires: "past" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* operationState(databaseClient, "operation-expired-lease")).toEqual([
          { state: "dispatched", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("publishes a durable terminal receipt after the assignment lease expires", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-terminal-expired-lease"
        yield* seed(databaseClient, operationKey)
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const connected = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* connected.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        yield* persistTerminal(connected, target, access, operationKey)
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ leaseExpiresAt: sql`transaction_timestamp() - interval '1 second'` })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )

        const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* restarted.execute(cellRequest(operationKey))).toMatchObject({
          response,
          outcome: "completed",
          eventPersisted: true,
        })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("releases the assignment without inventing terminal work on explicit goodbye", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-goodbye")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(
          authority({
            release: () =>
              pauseAssignment(databaseClient).pipe(
                Effect.asVoid,
                Effect.mapError((error) => ControllerError.make({ kind: "checkpoint", message: error.message })),
              ),
          }),
        ).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        yield* gateway.receive(target, encode({ _tag: "RunnerGoodbye", access }))
        expect(target.closed).toEqual([[1000, "shutdown"]])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ lifecycle: rikaHostedExecutorAssignments.lifecycle })
              .from(rikaHostedExecutorAssignments)
              .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
          ),
        ).toEqual([{ lifecycle: "paused" }])
        expect(yield* operationState(databaseClient, "operation-goodbye")).toEqual([{ state: "dispatched", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("accepts a retained completion on the same gateway after a passive disconnect", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-live")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const firstSocket = socket()
        yield* gateway.receive(
          firstSocket,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        yield* gateway.disconnected(firstSocket)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ state: rikaHostedExecutorOperations.state })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-live")),
          ),
        ).toEqual([{ state: "dispatched" }])
        const secondSocket = socket()
        yield* gateway.receive(
          secondSocket,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        yield* persistTerminal(gateway, secondSocket, access, "operation-live")
        yield* gateway.receive(
          secondSocket,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-live",
            attempt: 0,
            response,
          }),
        )
        expect(secondSocket.closed).toEqual([])
        expect(yield* operationState(databaseClient, "operation-live")).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("closes a local PTY frame as malformed", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-pty")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        yield* gateway.receive(
          target,
          '{"_tag":"PtyOpened","access":{"version":1,"fence":{"target":"runner","assignmentId":"assignment-local-gateway","assignmentGeneration":1,"instanceId":"11111111-1111-4111-8111-111111111111","executorId":"executor-local-gateway","processIncarnation":"process-local-gateway"},"leaseEpoch":1,"sessionToken":"session-local-gateway"},"pty":{"ptyId":"pty-1","command":"bash","cwd":"/tmp","cols":80,"rows":24}}',
        )
        expect(target.closed).toEqual([[1007, "malformed"]])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ state: rikaHostedExecutorOperations.state })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-pty")),
          ),
        ).toEqual([{ state: "dispatched" }])
      }),
    ),
  ),
)
