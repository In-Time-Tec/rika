import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityUser } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { Context, DateTime, Effect, Layer, Random, Redacted } from "effect"
import { and, asc, eq, inArray } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { ExecutableResolver, Runtime } from "generalist/runtime"
import { HostedRecovery, layer as hostedRecoveryLayer } from "../../../src/hosted/execution/recovery"
import {
  runOperations as generalistRunOperations,
  runs as generalistRuns,
} from "../../../src/hosted/execution/generalist-schema"
import { live as livePlatform } from "../../support/live-platform"

import { recoveryFixture } from "./recovery.fixture"
const { databaseUrl, executableManifest, executableRef, migrate, principal, storedMessage } = recoveryFixture

it.effect.skipIf(databaseUrl === "")("recovers terminal markers while preserving legacy direct recovery", () =>
  livePlatform(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_recovery_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const db = drizzle({ client: pool })
      try {
        yield* migrate(url, pool)
        const aggregateContext = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
        const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(aggregateContext))
        const current = DateTime.nowUnsafe()
        const now = DateTime.toDate(current)
        yield* Effect.tryPromise(() =>
          db.insert(identityUser).values([
            {
              id: "recovery-user",
              name: "Recovery",
              email: "recovery@example.test",
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "other-user",
              name: "Other",
              email: "other@example.test",
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          db.insert(rikaHostedOwners).values({ id: "recovery-owner", kind: "personal", userId: "recovery-user" }),
        )
        yield* aggregateDatabase.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(rikaHostedWorkspaces).values({
              id: "recovery-workspace",
              ownerId: "recovery-owner",
              createdByUserId: "recovery-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt: now,
            })
            yield* tx
              .insert(rikaWorkspaces)
              .values({ ownerId: "recovery-owner", path: "recovery-workspace", createdAt: 1 })
            yield* tx.insert(rikaHostedThreads).values({
              id: "recovery-thread",
              ownerId: "recovery-owner",
              workspaceId: "recovery-workspace",
              createdByUserId: "recovery-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt: now,
            })
            yield* tx.insert(rikaThreads).values({
              id: "recovery-thread",
              ownerId: "recovery-owner",
              workspace: "recovery-workspace",
              title: "Recovery",
              createdAt: 1,
              updatedAt: 1,
            })
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(rikaHostedExecutorAssignments).values({
            id: "recovery-assignment",
            ownerId: "recovery-owner",
            threadId: "recovery-thread",
            workspaceId: "recovery-workspace",
            executorKind: "orb",
            placement: { _tag: "OrbPlacement", templateBuildId: "build-recovery" },
            generation: 1,
            revision: 1,
            lastLeaseEpoch: 1,
            lifecycle: "active",
            providerInstanceId: "provider-recovery",
            executorInstanceId: "executor-recovery",
            processIncarnation: "process-recovery",
            sessionDigest: "session-recovery",
            leaseEpoch: 1,
            leaseExpiresAt: DateTime.toDate(DateTime.add(current, { minutes: 5 })),
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(generalistRuns).values(
            ["retry", "accept", "abort", "auto", "false"].map((runKind) => ({
              runId: `run-${runKind}`,
              status: "needs-resolution",
              address: "agent:recovery",
              sessionId: `session-${runKind}`,
              messageId: `message-${runKind}`,
              messageJson: storedMessage(runKind),
              messageDigest: `${runKind}-message-digest`,
              idempotencyKey: `run-${runKind}`,
              executableRefJson: executableRef,
              executableManifestJson: executableManifest,
              rootRunId: `run-${runKind}`,
              depth: 0,
              maxDepth: 8,
              maxSubagents: 8,
              acceptedSequence: 1,
              createdAt: now,
              updatedAt: now,
            })),
          ),
        )
        yield* Effect.tryPromise(() =>
          pool.query("INSERT INTO generalist_tree_roots (root_run_id) VALUES ($1)", ["run-abort"]),
        )
        yield* Effect.tryPromise(() =>
          db.insert(generalistRunOperations).values(recoveryFixture.generalistOperationRows(now)),
        )
        const deadlineAt = DateTime.toDate(DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"))
        yield* Effect.tryPromise(() =>
          db.insert(rikaHostedExecutorOperations).values(recoveryFixture.executorOperationRows(now, deadlineAt)),
        )
        const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })
        const resolver = yield* ExecutableResolver.makeStatic([])
        const context = yield* Layer.build(
          hostedRecoveryLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                postgres,
                AuthorizationPolicy.layer,
                ExecutionPostgres.layer({
                  postgres: {
                    url,
                    source: "hosted-recovery-live",
                    maxConnections: 4,
                    worker: {
                      workerId: "hosted-recovery-live",
                      concurrency: 1,
                      leaseMillis: 30_000,
                      fallbackIntervalMillis: 60_000,
                      cancellationIntervalMillis: 60_000,
                    },
                  },
                  resolver,
                }).pipe(Layer.provide(postgres)),
              ),
            ),
          ),
        )
        const recovery = Context.get(context, HostedRecovery)
        const runtime = Context.get(context, Runtime.Runtime)
        yield* recovery.reconcileCompleted
        const automaticallyRecovered = (yield* Effect.tryPromise(() =>
          db
            .select({
              status: generalistRunOperations.status,
              resolution_idempotency_key: generalistRunOperations.resolutionIdempotencyKey,
              resolution_json: generalistRunOperations.resolutionJson,
            })
            .from(generalistRunOperations)
            .where(eq(generalistRunOperations.operationId, "generalist-auto")),
        ))[0]
        expect(automaticallyRecovered).toEqual({
          status: "succeeded",
          resolution_idempotency_key: "generalist-auto:executor-terminal",
          resolution_json: '{"_tag":"Succeeded","value":{"_tag":"Success","result":{"text":"42","truncated":false}}}',
        })
        expect(
          yield* recovery.inspect({
            principal,
            threadId: "recovery-thread",
            runId: "run-false",
          }),
        ).toEqual([])
        const operations = yield* recovery.inspect({
          principal,
          threadId: "recovery-thread",
          runId: "run-retry",
        })
        expect(operations).toEqual([
          expect.objectContaining({ operationId: "generalist-retry", state: "needs-resolution", started: true }),
        ])
        expect(operations.every((operation) => operation.actions.join(",") === "inspect,retry,accept,abort")).toBe(true)
        const retryInput: Parameters<typeof recovery.resolve>[0] = {
          principal,
          threadId: "recovery-thread",
          runId: "run-retry",
          operationId: "generalist-retry",
          idempotencyKey: "resolve-retry",
          resolution: { _tag: "Retry" },
        }
        expect(yield* recovery.resolve(retryInput)).toMatchObject({ state: "retrying", actions: ["inspect"] })
        expect(yield* recovery.resolve(retryInput)).toMatchObject({ state: "retrying", actions: ["inspect"] })
        expect(
          (yield* Effect.result(recovery.resolve({ ...retryInput, idempotencyKey: "conflicting-retry" })))._tag,
        ).toBe("Failure")
        const acceptOperations = yield* recovery.inspect({
          principal,
          threadId: "recovery-thread",
          runId: "run-accept",
        })
        expect(acceptOperations).toEqual([
          expect.objectContaining({
            operationId: "generalist-accept",
            replayPolicy: "never",
            state: "needs-resolution",
            actions: ["inspect", "accept", "abort"],
          }),
        ])
        const markerRetry = yield* recovery
          .resolve({
            ...retryInput,
            runId: "run-accept",
            operationId: "generalist-accept",
            idempotencyKey: "invalid-marker-retry",
            resolution: { _tag: "Retry" },
          })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
        expect(markerRetry).toMatchObject({ kind: "invalid" })
        expect(
          yield* recovery.inspect({
            principal,
            threadId: "recovery-thread",
            runId: "run-abort",
          }),
        ).toEqual([
          expect.objectContaining({
            operationId: "generalist-abort",
            actions: ["inspect", "accept", "abort"],
          }),
        ])
        const resolvedAt = DateTime.toDate(DateTime.nowUnsafe())
        yield* Effect.tryPromise(() =>
          db
            .update(generalistRunOperations)
            .set({
              status: "succeeded",
              resultJson: '{"_tag":"Success","result":{"answer":42}}',
              resolutionIdempotencyKey: "resolve-accept",
              resolutionJson: '{"_tag":"Succeeded","value":{"_tag":"Success","result":{"answer":42}}}',
              finishedAt: resolvedAt,
            })
            .where(
              and(
                eq(generalistRunOperations.runId, "run-accept"),
                eq(generalistRunOperations.operationId, "generalist-accept"),
              ),
            ),
        )
        yield* Effect.tryPromise(() =>
          db
            .update(generalistRuns)
            .set({ status: "queued", ownerWorkerId: null, updatedAt: resolvedAt })
            .where(eq(generalistRuns.runId, "run-accept")),
        )
        expect(
          yield* recovery.resolve({
            ...retryInput,
            runId: "run-accept",
            operationId: "generalist-accept",
            idempotencyKey: "resolve-accept",
            resolution: { _tag: "Accept", value: { answer: 42 } },
          }),
        ).toMatchObject({ state: "accepted", resolution: { _tag: "Accept", value: { answer: 42 } } })
        expect(
          yield* recovery.inspect({
            principal,
            threadId: "recovery-thread",
            runId: "run-accept",
          }),
        ).toEqual([
          expect.objectContaining({ operationId: "generalist-accept", state: "accepted", actions: ["inspect"] }),
        ])
        yield* runtime.cancel({ runId: "run-abort", reason: "operator cancelled while outcome was unknown" })
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .select({ status: generalistRuns.status, cancellationRequested: generalistRuns.cancellationRequested })
              .from(generalistRuns)
              .where(eq(generalistRuns.runId, "run-abort")),
          ))[0],
        ).toEqual({ status: "needs-resolution", cancellationRequested: true })
        expect(
          yield* recovery.resolve({
            ...retryInput,
            runId: "run-abort",
            operationId: "generalist-abort",
            idempotencyKey: "resolve-abort",
            resolution: { _tag: "Abort", reason: "operator confirmed failure" },
          }),
        ).toMatchObject({ state: "aborted" })
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .select({ status: generalistRuns.status, cancellationRequested: generalistRuns.cancellationRequested })
              .from(generalistRuns)
              .where(eq(generalistRuns.runId, "run-abort")),
          ))[0],
        ).toEqual({ status: "cancelled", cancellationRequested: true })
        expect(
          (yield* Effect.tryPromise(() =>
            pool.query(`SELECT column_name FROM information_schema.columns
                  WHERE table_name = 'rika_hosted_executor_operations'
                    AND column_name IN ('resolution_state', 'resolution_idempotency_key', 'resolution', 'resolved_at')`),
          )).rows,
        ).toEqual([])
        expect(
          yield* Effect.tryPromise(() =>
            db
              .select({
                operation_id: generalistRunOperations.operationId,
                status: generalistRunOperations.status,
                resolution_idempotency_key: generalistRunOperations.resolutionIdempotencyKey,
                resolution_json: generalistRunOperations.resolutionJson,
              })
              .from(generalistRunOperations)
              .where(
                inArray(generalistRunOperations.operationId, [
                  "generalist-retry",
                  "generalist-accept",
                  "generalist-abort",
                ]),
              )
              .orderBy(asc(generalistRunOperations.operationId)),
          ),
        ).toEqual([
          {
            operation_id: "generalist-abort",
            status: "failed",
            resolution_idempotency_key: "resolve-abort",
            resolution_json:
              '{"_tag":"Failed","error":{"_tag":"UserAbortedUnknownOperation","message":"operator confirmed failure"}}',
          },
          {
            operation_id: "generalist-accept",
            status: "succeeded",
            resolution_idempotency_key: "resolve-accept",
            resolution_json: '{"_tag":"Succeeded","value":{"_tag":"Success","result":{"answer":42}}}',
          },
          {
            operation_id: "generalist-retry",
            status: "requested",
            resolution_idempotency_key: "resolve-retry",
            resolution_json: '{"_tag":"Retry"}',
          },
        ])
        expect(
          yield* Effect.tryPromise(() =>
            db
              .select({
                operation_id: generalistRunOperations.operationId,
                status: generalistRunOperations.status,
                resolution_json: generalistRunOperations.resolutionJson,
              })
              .from(generalistRunOperations)
              .where(
                inArray(generalistRunOperations.operationId, [
                  "generalist-accept-outer",
                  "generalist-abort-outer",
                  "generalist-auto-outer",
                  "generalist-false-outer",
                ]),
              )
              .orderBy(asc(generalistRunOperations.operationId)),
          ),
        ).toEqual([
          { operation_id: "generalist-abort-outer", status: "failed", resolution_json: null },
          { operation_id: "generalist-accept-outer", status: "failed", resolution_json: null },
          { operation_id: "generalist-auto-outer", status: "failed", resolution_json: null },
          { operation_id: "generalist-false-outer", status: "failed", resolution_json: null },
        ])
        expect(
          (yield* Effect.result(
            recovery.inspect({
              principal: { userId: "other-user", deviceId: "other-device", clientId: "other-client" },
              threadId: "recovery-thread",
              runId: "run-retry",
            }),
          ))._tag,
        ).toBe("Failure")
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ),
)
