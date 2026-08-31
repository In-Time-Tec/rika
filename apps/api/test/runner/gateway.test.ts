import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { rikaHostedExecutorOperations, rikaHostedThreadEvents } from "@rika/product-store/database-schema"
import * as HostedPostgres from "@rika/product-store/layer"
import { eq, sql } from "drizzle-orm"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import {
  access,
  assignmentId,
  authority,
  bindingRequestDigest,
  cellRequest,
  decode,
  encode,
  live,
  makeRunnerGateway,
  operationAttribution,
  persistTerminal,
  response,
  socket,
} from "./gateway/harness"
import { eventually, isolated, operationState, seed } from "./gateway/database.harness"
import "./gateway/authorization.harness"
import "./gateway/cancellation.harness"
import "./gateway/completion.harness"

it.effect.skipIf(!live)(
  "keeps a dispatched operation after a passive disconnect and accepts the retained result after restart",
  () =>
    isolated(({ url, databaseClient }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(databaseClient, "operation-restart")
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
          )
          const first = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
          const firstSocket = socket()
          yield* first.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
          const attribution = operationAttribution("operation-restart")
          yield* first.receive(
            firstSocket,
            encode({ _tag: "CellLifecycle", access, frame: { _tag: "Accepted", attribution, cursor: 1 } }),
          )
          yield* first.receive(
            firstSocket,
            encode({ _tag: "CellLifecycle", access, frame: { _tag: "Started", attribution, cursor: 2 } }),
          )
          yield* first.disconnected(firstSocket)
          expect(
            yield* Effect.tryPromise(() =>
              databaseClient
                .select({ state: rikaHostedExecutorOperations.state })
                .from(rikaHostedExecutorOperations)
                .where(eq(rikaHostedExecutorOperations.operationKey, "operation-restart")),
            ),
          ).toEqual([{ state: "dispatched" }])

          const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
          const secondSocket = socket()
          yield* restarted.receive(secondSocket, encode({ _tag: "ExecutorReconnect", access }))
          expect(decode(secondSocket.sent[0]!)).toMatchObject({ _tag: "ExecutorReconnected" })
          expect(
            secondSocket.sent.map((value) => decode(value)).find((message) => message._tag === "CellReplay"),
          ).toEqual({
            _tag: "CellReplay",
            access,
            operationKey: "operation-restart",
            attempt: 0,
            afterCursor: 2,
          })
          const reattached = yield* Effect.forkChild(
            restarted.execute({
              ...cellRequest("operation-restart", "2026-08-25T00:02:00.000Z"),
              admittedAt: "2026-08-25T00:00:00.000Z",
            }),
          )
          expect(
            yield* eventually(() =>
              secondSocket.sent
                .map((value) => decode(value))
                .find(
                  (message) => message._tag === "CellExecute" && message.request.operationKey === "operation-restart",
                ),
            ),
          ).toMatchObject({
            _tag: "CellExecute",
            request: {
              operationKey: "operation-restart",
              admittedAt: null,
              deadlineAt: "2999-01-01T00:00:00.000Z",
            },
          })
          const bindingRequest = {
            module: "missing",
            operation: "missing",
            input: {},
            sessionId: assignmentId,
            cellId: "call-local-gateway",
          } as const
          yield* restarted.receive(
            secondSocket,
            encode({
              _tag: "BindingInvoke",
              access,
              operationKey: "operation-restart",
              attempt: 0,
              callId: "operation-restart:binding:0",
              requestDigest: bindingRequestDigest(bindingRequest),
              request: bindingRequest,
            }),
          )
          expect(
            secondSocket.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult"),
          ).toHaveLength(1)
          yield* restarted.receive(
            secondSocket,
            encode({
              _tag: "CellLifecycle",
              access,
              frame: { _tag: "Terminal", attribution, cursor: 3, outcome: "completed", response },
            }),
          )
          const result = encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-restart",
            attempt: 0,
            response,
          })
          yield* restarted.receive(secondSocket, result)
          yield* restarted.receive(secondSocket, result)
          expect(yield* Fiber.join(reattached)).toMatchObject({ response, outcome: "completed" })
          expect(secondSocket.closed).toEqual([])
          expect(
            secondSocket.sent.map((value) => decode(value)).filter((message) => message._tag === "LocalCellReceipt"),
          ).toHaveLength(2)
          expect(yield* operationState(databaseClient, "operation-restart")).toEqual([
            { state: "completed", events: 1 },
          ])
        }),
      ),
    ),
)

it.effect.skipIf(!live)("redelivers an unacknowledged Cell execute and stops after acceptance", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-redelivery"
        yield* seed(databaseClient, operationKey)
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        const running = yield* Effect.forkChild(gateway.execute(cellRequest(operationKey)))
        const deliveries = () =>
          target.sent
            .map((value) => decode(value))
            .filter((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey)

        yield* eventually(() => (deliveries().length === 1 ? true : undefined))
        yield* TestClock.adjust("249 millis")
        expect(deliveries()).toHaveLength(1)
        yield* TestClock.adjust("1 millis")
        yield* eventually(() => (deliveries().length === 2 ? true : undefined))

        yield* gateway.disconnected(target)
        const replacement = socket()
        yield* gateway.receive(replacement, encode({ _tag: "ExecutorReconnect", access }))
        const replayed = replacement.sent.map((value) => decode(value))
        expect(replayed[0]).toMatchObject({ _tag: "ExecutorReconnected" })
        expect(
          replayed.filter((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey),
        ).toHaveLength(1)
        expect(replayed.filter((message) => message._tag === "CellReplay" && message.operationKey === operationKey)).toEqual(
          [],
        )

        yield* gateway.receive(
          replacement,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: { _tag: "Accepted", attribution: operationAttribution(operationKey), cursor: 1 },
          }),
        )
        yield* TestClock.adjust("1 second")
        expect(deliveries()).toHaveLength(2)
        expect(
          replacement.sent
            .map((value) => decode(value))
            .filter((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey),
        ).toHaveLength(1)

        yield* persistTerminal(gateway, replacement, access, operationKey)
        expect(yield* Fiber.join(running)).toMatchObject({ response, outcome: "completed" })
      }),
    ),
  ),
)

it.effect.skipIf(!live)("replays the exact durable cancelled terminal without dispatching", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-cancelled")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        const cancelled = {
          _tag: "DomainFailure" as const,
          failure: { kind: "cancelled", message: "Cell operation was cancelled" },
        }
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* persistTerminal(gateway, target, access, "operation-cancelled", cancelled, "cancelled")
        const first = yield* gateway.execute(cellRequest("operation-cancelled"))
        const replay = yield* gateway.execute(cellRequest("operation-cancelled"))
        expect(first).toMatchObject({ response: cancelled, outcome: "cancelled", eventPersisted: true })
        expect(replay).toEqual(first)
        expect(
          target.sent
            .map((value) => decode(value))
            .filter(
              (message) => message._tag === "CellExecute" && message.request.operationKey === "operation-cancelled",
            ),
        ).toEqual([])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({
                state: rikaHostedExecutorOperations.state,
                terminalOutcome: rikaHostedExecutorOperations.terminalOutcome,
                response: rikaHostedExecutorOperations.response,
              })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-cancelled")),
          ),
        ).toEqual([{ state: "completed", terminalOutcome: "cancelled", response: cancelled }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("terminalizes repeated cancellation before Runner dispatch", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-cancel-accepted"
        yield* seed(databaseClient, operationKey, { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))

        const first = yield* gateway.cancel(cellRequest(operationKey))
        const repeated = yield* gateway.cancel(cellRequest(operationKey))

        expect(repeated).toEqual(first)
        expect(first).toMatchObject({ outcome: "cancelled", eventPersisted: true })
        expect(
          target.sent
            .map((value) => decode(value))
            .filter(
              (message) =>
                (message._tag === "CellExecute" && message.request.operationKey === operationKey) ||
                (message._tag === "CellCancel" && message.operationKey === operationKey),
            ),
        ).toEqual([])
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("waits for a dispatched Runner cancellation terminal and redelivers after restart", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-cancel-restart"
        const cancelled = {
          _tag: "DomainFailure" as const,
          failure: { kind: "cancelled", message: "Cell operation was cancelled" },
        }
        yield* seed(databaseClient, operationKey)
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const first = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const firstSocket = socket()
        yield* first.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
        const interrupted = yield* Effect.forkChild(first.cancel(cellRequest(operationKey)))
        yield* eventually(() =>
          firstSocket.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
        )
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])
        yield* first.disconnected(firstSocket)
        yield* Fiber.interrupt(interrupted)

        const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const secondSocket = socket()
        yield* restarted.receive(secondSocket, encode({ _tag: "ExecutorReconnect", access }))
        const cancelling = yield* Effect.forkChild(restarted.cancel(cellRequest(operationKey)))
        yield* eventually(() =>
          secondSocket.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
        )
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])

        yield* persistTerminal(restarted, secondSocket, access, operationKey, cancelled, "cancelled")
        yield* TestClock.adjust("100 millis")
        expect(yield* Fiber.join(cancelling)).toMatchObject({
          response: cancelled,
          outcome: "cancelled",
          eventPersisted: true,
        })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("accepts the Runner terminal that arrives after the caller deadline", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:01.000Z"
        yield* seed(databaseClient, "operation-deadline-first", { deadlineAt })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        const cancelled = {
          _tag: "DomainFailure" as const,
          failure: { kind: "cancelled", message: "Cell operation was cancelled" },
        }
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        const running = yield* Effect.forkChild(gateway.execute(cellRequest("operation-deadline-first", deadlineAt)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find(
              (message) =>
                message._tag === "CellExecute" && message.request.operationKey === "operation-deadline-first",
            ),
        )
        yield* TestClock.adjust("1 second")
        expect(running.pollUnsafe()).toBeUndefined()
        expect(
          target.sent
            .map((value) => decode(value))
            .some((message) => message._tag === "CellCancel" && message.operationKey === "operation-deadline-first"),
        ).toBe(false)
        yield* TestClock.adjust("100 millis")
        yield* persistTerminal(gateway, target, access, "operation-deadline-first", cancelled, "cancelled")
        expect(yield* Fiber.join(running)).toMatchObject({
          response: cancelled,
          outcome: "cancelled",
          eventPersisted: true,
        })
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-deadline-first",
            attempt: 0,
            response: cancelled,
          }),
        )
        expect(target.closed).toEqual([])
        expect(
          target.sent
            .map((value) => decode(value))
            .some(
              (message) =>
                message._tag === "CellTerminalReceipt" && message.operationKey === "operation-deadline-first",
            ),
        ).toBe(true)
        expect(
          target.sent
            .map((value) => decode(value))
            .some(
              (message) => message._tag === "LocalCellReceipt" && message.operationKey === "operation-deadline-first",
            ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({
                state: rikaHostedExecutorOperations.state,
                terminalOutcome: rikaHostedExecutorOperations.terminalOutcome,
                response: rikaHostedExecutorOperations.response,
              })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-deadline-first")),
          ),
        ).toEqual([{ state: "completed", terminalOutcome: "cancelled", response: cancelled }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("atomically persists one accepted deadline result across concurrent gateways", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:00.000Z"
        const operationKey = "operation-accepted-deadline"
        yield* seed(databaseClient, operationKey, { deadlineAt, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.execute(sql`CREATE FUNCTION rika_test_reject_deadline_event() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected deadline event failure'; END
          $$;
          CREATE TRIGGER rika_test_reject_deadline_event
            BEFORE INSERT ON rika_hosted_thread_events
            FOR EACH ROW EXECUTE FUNCTION rika_test_reject_deadline_event()`),
        )
        const faulty = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect((yield* Effect.result(faulty.execute(cellRequest(operationKey, deadlineAt))))._tag).toBe("Failure")
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "accepted", events: 0 }])
        yield* Effect.tryPromise(() =>
          databaseClient.execute(sql`DROP TRIGGER rika_test_reject_deadline_event ON rika_hosted_thread_events;
          DROP FUNCTION rika_test_reject_deadline_event()`),
        )
        const first = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const second = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const results = yield* Effect.all(
          [first.execute(cellRequest(operationKey, deadlineAt)), second.execute(cellRequest(operationKey, deadlineAt))],
          { concurrency: "unbounded" },
        )
        const timeout = {
          _tag: "DomainFailure" as const,
          failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
        }
        expect(results).toEqual([
          { response: timeout, outcome: "failed", eventPersisted: true },
          { response: timeout, outcome: "failed", eventPersisted: true },
        ])

        const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* restarted.execute(cellRequest(operationKey, deadlineAt))).toEqual(results[0])
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ event: rikaHostedThreadEvents.event })
              .from(rikaHostedThreadEvents)
              .where(eq(rikaHostedThreadEvents.idempotencyKey, operationKey)),
          ),
        ).toEqual([{ event: { _tag: "CellResult", operationKey, response: timeout } }])
      }),
    ),
  ),
)
