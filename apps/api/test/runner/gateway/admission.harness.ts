import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import {
  rikaHostedExecutorAssignments,
  rikaHostedWorkspaceCapabilityAdmissions,
} from "@rika/product-store/database-schema"
import { layer as operationsLayer, HostedExecutionOperations } from "@rika/product-store/executor-operations"
import * as HostedPostgres from "@rika/product-store/layer"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { isolated, seed } from "./database.harness"
import {
  access,
  assignmentId,
  authority,
  encode,
  environmentDigest,
  live,
  makeRunnerGateway,
  socket,
  threadId,
  workspaceCapabilities,
} from "./harness"

it.effect.skipIf(!live)(
  "serializes Runner capability admission with disconnect and releases the lock on interruption",
  () =>
    isolated(({ url }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 4 }), BunCrypto.layer),
          )
          const validating = yield* Deferred.make<void>()
          const authorize = yield* Deferred.make<void>()
          const gateway = yield* makeRunnerGateway(
            authority({
              validateAccess: () =>
                Deferred.succeed(validating, undefined).pipe(Effect.andThen(Deferred.await(authorize))),
            }),
          ).pipe(Effect.provide(context))
          const target = socket()
          yield* gateway.receive(
            target,
            encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
          )
          const order: string[] = []
          const admission = yield* gateway
            .withReadySession(assignmentId, (generation) =>
              Effect.sync(() => {
                expect(generation).toBe(1)
                order.push("admitted")
              }),
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(validating)
          const disconnectStarted = yield* Deferred.make<void>()
          const disconnect = yield* Deferred.succeed(disconnectStarted, undefined).pipe(
            Effect.andThen(gateway.disconnected(target)),
            Effect.andThen(Effect.sync(() => order.push("disconnected"))),
            Effect.forkChild,
          )
          yield* Deferred.await(disconnectStarted)
          yield* Deferred.succeed(authorize, undefined)
          yield* Fiber.join(admission)
          yield* Fiber.join(disconnect)
          expect(order).toEqual(["admitted", "disconnected"])
          expect(
            yield* gateway
              .withReadySession(assignmentId, () => Effect.die("offline admission must not execute"))
              .pipe(Effect.flip),
          ).toMatchObject({ kind: "disconnected" })

          yield* gateway.receive(
            target,
            encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
          )
          const entered = yield* Deferred.make<void>()
          const cancelled = yield* gateway
            .withReadySession(assignmentId, () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(cancelled)
          yield* gateway.disconnected(target)
          expect(
            yield* gateway
              .withReadySession(assignmentId, () => Effect.die("cancelled admission must not resume"))
              .pipe(Effect.flip),
          ).toMatchObject({ kind: "disconnected" })
        }),
      ),
    ),
)

it.effect.skipIf(!live)("does not persist a capability admission after its checked generation was replaced", () =>
  isolated(({ databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "admission-generation")
        const context = yield* Layer.build(operationsLayer)
        const operations = yield* HostedExecutionOperations.pipe(Effect.provide(context))
        const request = {
          threadId,
          turnId: "replacement-admission",
          assignmentId,
          workspaceId: "workspace-local-gateway",
          assignmentGeneration: 1,
          environmentDigest,
          requiredCapabilities: ["filesystem", "nativeTools", "git", "process", "workspaceLifecycle"],
        }
        // Readiness saw g1. A replacement commits before the admission transaction starts;
        // an identical environment digest must not turn that stale read into authorization.
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ generation: 2 })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        // Replacement clears the old snapshot; only the new handshake may publish g2 capabilities.
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ capabilityGeneration: 2, capabilitySnapshot: workspaceCapabilities })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        expect(yield* operations.admitWorkspaceCapabilities(request)).toBe(false)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select()
              .from(rikaHostedWorkspaceCapabilityAdmissions)
              .where(eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, request.turnId)),
          ),
        ).toEqual([])
        const current = { ...request, assignmentGeneration: 2 }
        expect(yield* operations.admitWorkspaceCapabilities(current)).toBe(true)
        expect(yield* operations.admitWorkspaceCapabilities(current)).toBe(true)
        expect(
          yield* operations.admitWorkspaceCapabilities({ ...current, turnId: "wrong-workspace", workspaceId: "other" }),
        ).toBe(false)
        expect(
          yield* operations.admitWorkspaceCapabilities({
            ...current,
            turnId: "wrong-environment",
            environmentDigest: `sha256:${"1".repeat(64)}`,
          }),
        ).toBe(false)
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        expect(yield* operations.admitWorkspaceCapabilities({ ...current, turnId: "expired-lease" })).toBe(false)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ generation: rikaHostedWorkspaceCapabilityAdmissions.assignmentGeneration })
              .from(rikaHostedWorkspaceCapabilityAdmissions)
              .where(eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, request.turnId)),
          ),
        ).toEqual([{ generation: 2 }])
      }),
    ),
  ),
)
