import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { cliRegistration, identityMember } from "@rika/identity"
import {
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedRunnerAdmissions,
  rikaHostedRunnerRegistrations,
} from "@rika/product-store/database-schema"
import * as HostedPostgres from "@rika/product-store/layer"
import { count, eq, sql } from "drizzle-orm"
import { Effect, Fiber, Layer, Redacted } from "effect"
import {
  access,
  assignmentId,
  authority,
  cellRequest,
  decode,
  deviceId,
  encode,
  live,
  makeRunnerGateway,
  persistTerminal,
  response,
  socket,
  workspaceCapabilities,
} from "./harness"
import { eventually, isolated, operationState, seed } from "./database.harness"

it.effect.skipIf(!live)("fences organization dispatch immediately after membership deletion", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-revoked-membership", { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* Effect.tryPromise(() =>
          databaseClient.delete(identityMember).where(eq(identityMember.id, "member-local-gateway")),
        )
        const error = yield* gateway.execute(cellRequest("operation-revoked-membership")).pipe(Effect.flip)
        expect(error).toMatchObject({
          kind: "fenced",
          message: "Runner fence is no longer current",
        })
        expect(yield* operationState(databaseClient, "operation-revoked-membership")).toEqual([
          { state: "accepted", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("durably revokes a Runner immediately after device revocation", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-revoked-device", { state: "accepted" })
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedRunnerRegistrations).values({
            deviceId,
            userId: "user-local-gateway",
            checkoutFingerprint: "checkout-local-gateway",
            workspaceId: "workspace-local-gateway",
            repository: {},
            kernelProfile: {},
            capabilities: {},
          }),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        let active = true
        const gateway = yield* makeRunnerGateway(
          authority({
            validateAccess: () =>
              active ? Effect.void : Effect.fail(ControllerError.make({ kind: "fenced", message: "revoked" })),
          }),
        ).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* Effect.yieldNow
        expect(yield* gateway.active(target)).toBe(true)

        yield* Effect.tryPromise(() =>
          databaseClient
            .update(cliRegistration)
            .set({ revokedAt: sql`transaction_timestamp()` })
            .where(eq(cliRegistration.clientId, "client-local-gateway")),
        )

        active = false
        expect(yield* gateway.active(target)).toBe(false)
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-revoked-device",
            attempt: 0,
            response,
          }),
        )
        yield* Effect.yieldNow
        expect(target.closed).toContainEqual([1008, "fenced"])
        const revoked = yield* Effect.tryPromise(() =>
          databaseClient
            .select({
              deviceRevokedAt: rikaHostedDevices.revokedAt,
              clientRevokedAt: rikaHostedClients.revokedAt,
              admissionRevokedAt: rikaHostedRunnerAdmissions.revokedAt,
              lifecycle: rikaHostedExecutorAssignments.lifecycle,
              generation: rikaHostedExecutorAssignments.generation,
            })
            .from(rikaHostedDevices)
            .innerJoin(rikaHostedClients, eq(rikaHostedClients.deviceId, rikaHostedDevices.id))
            .innerJoin(rikaHostedRunnerAdmissions, eq(rikaHostedRunnerAdmissions.clientId, rikaHostedClients.id))
            .innerJoin(
              rikaHostedExecutorAssignments,
              eq(rikaHostedExecutorAssignments.id, rikaHostedRunnerAdmissions.assignmentId),
            )
            .where(eq(rikaHostedDevices.id, deviceId)),
        )
        const registered = yield* Effect.tryPromise(() =>
          databaseClient.select({ count: count() }).from(rikaHostedRunnerRegistrations),
        )
        expect(
          revoked.map((row) => ({
            deviceRevoked: row.deviceRevokedAt !== null,
            clientRevoked: row.clientRevokedAt !== null,
            admissionRevoked: row.admissionRevokedAt !== null,
            lifecycle: row.lifecycle,
            generation: row.generation,
            runnerRegistered: (registered[0]?.count ?? 0) !== 0,
          })),
        ).toEqual([
          {
            deviceRevoked: true,
            clientRevoked: true,
            admissionRevoked: true,
            lifecycle: "terminated",
            generation: 2,
            runnerRegistered: false,
          },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("rejects dispatch after the admitted workspace environment digest changes", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-environment-changed", { state: "accepted" })
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ capabilitySnapshot: { ...workspaceCapabilities, environmentDigest: `sha256:${"1".repeat(64)}` } })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        expect(yield* gateway.execute(cellRequest("operation-environment-changed")).pipe(Effect.flip)).toMatchObject({
          kind: "fenced",
          message: "Runner fence is no longer current",
        })
        expect(yield* operationState(databaseClient, "operation-environment-changed")).toEqual([
          { state: "accepted", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("keeps uncertain delivery dispatched for receipt replay", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-personal", { ownerKind: "personal", state: "accepted" })
        expect(yield* Effect.tryPromise(() => databaseClient.select({ count: count() }).from(identityMember))).toEqual([
          { count: 0 },
        ])
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        target.failSend = true
        const running = yield* Effect.forkChild(gateway.execute(cellRequest("operation-personal")))
        yield* eventually(() =>
          target.sent.map((value) => decode(value)).find((message) => message._tag === "CellExecute"),
        )
        yield* Fiber.interrupt(running)
        expect(target.sent.map((value) => decode(value)).some((message) => message._tag === "CellCancel")).toBe(false)
        expect(yield* operationState(databaseClient, "operation-personal")).toEqual([
          { state: "dispatched", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)(
  "rejects a completion whose current assignment lease does not match the presented session",
  () =>
    isolated(({ url, databaseClient }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(databaseClient, "operation-stale", { leaseEpoch: 1 })
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
          )
          const gateway = yield* makeRunnerGateway(authority({ renewedLeaseEpoch: 2 })).pipe(Effect.provide(context))
          const target = socket()
          const renewed = { ...access, leaseEpoch: 2 }
          yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access: renewed }))
          yield* persistTerminal(gateway, target, renewed, "operation-stale")
          expect(target.closed).toEqual([[1008, "fenced"]])
          expect(
            yield* Effect.tryPromise(() =>
              databaseClient
                .select({ state: rikaHostedExecutorOperations.state })
                .from(rikaHostedExecutorOperations)
                .where(eq(rikaHostedExecutorOperations.operationKey, "operation-stale")),
            ),
          ).toEqual([{ state: "dispatched" }])
        }),
      ),
    ),
)
