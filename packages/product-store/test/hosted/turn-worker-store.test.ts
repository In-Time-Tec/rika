import * as PgClient from "@effect/sql-pg/PgClient"

import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type { Access } from "@rika/product/executor-assignments"
import {
  AssignmentLeaseEpoch,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { WorkspacePreparations } from "@rika/product/workspace-preparation"
import { HostedTurnWorkerStore, layer as workerStoreLayer } from "../../src/hosted/turn-worker-store"
import { layer as workspacePreparationLayer } from "../../src/hosted/workspace-preparations"
import { Config, Context, Effect, FileSystem, Inspectable, Layer, Logger, Random, Redacted, Schema } from "effect"
import { eq, sql as drizzleSql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { runMigration } from "../../../identity/src/database/postgres"
import { migrations } from "../../src/hosted/migrations"
import { identityUser } from "@rika/identity"
import * as schema from "../../src/database/schema/product"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const readFileString = (url: URL) =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((context) =>
        Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(fileURLToPath(url))),
          context,
        ),
      ),
    ),
  )

const request = (workerId: string, claimToken: string, leaseMillis = 100) => ({
  workerId,
  claimToken,
  leaseMillis,
})

it.effect.skipIf(databaseUrl === "")("fences Turn claims and recovers prepared execution admission", () => {
  const observations: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.map(Logger.formatStructured, (record) => observations.push(record))
  return Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_turn_worker_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const db = drizzle({ client: pool })
      try {
        for (const migration of [...identityMigrations, ...migrations]) {
          const sql = yield* readFileString(migration.url)
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const route = yield* Schema.encodeEffect(Schema.fromJsonString(ExecutionRoute.ExecutionRouteSnapshot))(
          ExecutionRoute.testExecutionRoute(),
        )
        const now = drizzleSql`now()`
        yield* Effect.tryPromise(() =>
          db.insert(identityUser).values({
            id: "worker-user",
            name: "Worker",
            email: "worker@example.test",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaHostedOwners).values({ id: "worker-owner", kind: "personal", userId: "worker-user" }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaHostedWorkspaces).values({
            id: "workspace-1",
            ownerId: "worker-owner",
            createdByUserId: "worker-user",
            executorKind: "orb",
            inheritProjectGrants: false,
            createdAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaHostedThreads).values({
            id: "thread-1",
            ownerId: "worker-owner",
            workspaceId: "workspace-1",
            createdByUserId: "worker-user",
            executorKind: "orb",
            inheritProjectGrants: false,
            createdAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaWorkspaces).values({ ownerId: "worker-owner", path: "workspace-1", createdAt: 1 }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaThreads).values({
            id: "thread-1",
            ownerId: "worker-owner",
            workspace: "workspace-1",
            title: "Worker",
            createdAt: 1,
            updatedAt: 1,
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaTurns).values([
            {
              id: "turn-1",
              threadId: "thread-1",
              prompt: "first",
              status: "queued",
              createdAt: 2,
              updatedAt: 2,
              executionRouteJson: route,
            },
            {
              id: "turn-2",
              threadId: "thread-1",
              prompt: "second",
              status: "queued",
              createdAt: 3,
              updatedAt: 3,
              executionRouteJson: route,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaThreadQueueState).values({ threadId: "thread-1", revision: 2, queuedCount: 2 }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaHostedExecutorAssignments).values({
            id: "assignment-1",
            ownerId: "worker-owner",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            executorKind: "orb",
            placement: { _tag: "OrbPlacement", templateBuildId: "build-1", providerScope: "test" },
            generation: 1,
            revision: 0,
            lastLeaseEpoch: 1,
            lifecycle: "active",
            providerInstanceId: "sandbox-1",
            executorInstanceId: "executor-1",
            processIncarnation: "process-1",
            sessionDigest: "session-1",
            leaseEpoch: 1,
            leaseExpiresAt: drizzleSql`clock_timestamp() + interval '4 minutes'`,
          }),
        )
        const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })
        const context = yield* Layer.build(
          Layer.merge(workerStoreLayer, workspacePreparationLayer).pipe(Layer.provide(postgres)),
        )
        const store = Context.get(context, HostedTurnWorkerStore)
        const preparations = Context.get(context, WorkspacePreparations)
        const claims = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => request(`worker-${index}`, `claim-${index}`)),
          store.claimNext,
          { concurrency: "unbounded" },
        )
        expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
        const first = claims.find((claim) => claim !== undefined)
        if (first === undefined) return yield* Effect.die("Turn was not claimed")
        expect(first.input).toMatchObject({ turnId: "turn-1", threadId: "thread-1", prompt: "first" })
        expect(first.expiresAt - first.claimedAt).toBe(100)
        expect(yield* store.renew(first, 5_000)).toBe(true)
        const access: Access = {
          assignmentId: ExecutorAssignmentId.make("assignment-1"),
          assignmentGeneration: FencingGeneration.make("1"),
          providerInstanceId: "sandbox-1",
          executorInstanceId: ExecutorInstanceId.make("executor-1"),
          processIncarnation: "process-1",
          leaseEpoch: AssignmentLeaseEpoch.make("1"),
          presentedSessionCredentialDigest: Redacted.make("session-1"),
        }
        const firstStart = {
          access,
          workspaceId: "workspace-1",
          phase: "checkout" as const,
          attempt: 1,
          now: 1_000,
          deadlineAt: 1_002,
        }
        expect((yield* preparations.start(firstStart)).state).toBe("preparing")
        expect((yield* preparations.start(firstStart)).attempt).toBe(1)
        yield* preparations.appendOutput({
          access,
          phase: "checkout",
          attempt: 1,
          stream: "stdout",
          text: "bounded redacted output",
          redacted: true,
          truncated: false,
          now: 1_001,
        })
        expect(yield* preparations.expireOverdue(1_001)).toBe(0)
        expect(yield* preparations.expireOverdue(1_002)).toBe(1)
        expect(yield* preparations.retryAttempt(access)).toBe(2)
        const retry = { ...firstStart, phase: "setup" as const, attempt: 2, now: 2_000, deadlineAt: 32_000 }
        yield* preparations.start(retry)
        const digest = `sha256:${"a".repeat(64)}`
        const evidence = {
          workspaceId: WorkspaceId.make("workspace-1"),
          repositoryId: null,
          commitSha: null,
          kernelProfileDigest: "a".repeat(64),
          bindingContractDigest: "b".repeat(64),
          setup: {
            digest: null,
            commitSha: null,
            buildDigest: digest,
            environmentDigest: digest,
            startedAt: 2_000,
            finishedAt: 2_001,
            outcome: "missing" as const,
          },
          resume: null,
          capabilities: ["bun"],
        }
        const completion = { ...retry, phase: "capabilities" as const, evidence, now: 2_002 }
        expect((yield* preparations.complete(completion)).state).toBe("ready")
        expect((yield* preparations.complete(completion)).state).toBe("ready")
        expect((yield* preparations.requireReady(access)).attempt).toBe(2)
        expect(
          (yield* Effect.result(preparations.requireReady({ ...access, leaseEpoch: AssignmentLeaseEpoch.make("2") })))
            ._tag,
        ).toBe("Failure")
        const durableClaim = yield* Effect.tryPromise(() =>
          db
            .select({ threadId: schema.rikaHostedTurnClaims.threadId, turnId: schema.rikaHostedTurnClaims.turnId })
            .from(schema.rikaHostedTurnClaims)
            .where(eq(schema.rikaHostedTurnClaims.turnId, "turn-1")),
        )
        expect(durableClaim).toEqual([{ threadId: "thread-1", turnId: "turn-1" }])
        const claimLogs = observations.filter((record) =>
          Inspectable.toStringUnknown(record).includes("hosted.turn_claim.success"),
        )
        expect(claimLogs).toHaveLength(1)
        const renderedClaim = Inspectable.toStringUnknown(claimLogs)
        expect(renderedClaim).toContain("thread-1")
        expect(renderedClaim).toContain("turn-1")
        for (const secret of ["worker-owner", "claim-0", "first"]) expect(renderedClaim).not.toContain(secret)
        const preparedExecution: ExecutionGateway.PreparedTurn = {
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "turn-1",
          rootAdmissionJson: "{}",
        }
        expect(yield* store.prepare(first, preparedExecution, 101)).toBe(true)
        expect(yield* store.claimRecovery(request("early", "early-claim"))).toBeUndefined()
        yield* Effect.tryPromise(() =>
          db
            .update(schema.rikaHostedTurnClaims)
            .set({ heartbeatAt: 0, expiresAt: 1 })
            .where(eq(schema.rikaHostedTurnClaims.turnId, "turn-1")),
        )
        const recovered = yield* store.claimRecovery(request("recovery", "recovery-claim"))
        if (recovered === undefined) return yield* Effect.die("Prepared Turn was not recovered")
        expect(recovered).toMatchObject({ preparedExecution, input: first.input })
        const link = { runId: "turn-1", turnId: "turn-1", threadId: "thread-1" }
        yield* store.completeAdmission(recovered, link, 202)
        expect(yield* store.requestActivation(recovered, 203)).toBe(true)
        const durable = yield* Effect.tryPromise(() =>
          db
            .select({ status: schema.rikaTurns.status, executionLinkJson: schema.rikaTurns.executionLinkJson })
            .from(schema.rikaTurns)
            .where(eq(schema.rikaTurns.id, "turn-1")),
        )
        expect(durable[0]).toMatchObject({ status: "accepted" })
        const executionLink = yield* Schema.decodeEffect(Schema.fromJsonString(ExecutionGateway.ExecutionLink))(
          String(durable[0]?.executionLinkJson),
        )
        expect(executionLink).toEqual(link)
        expect((yield* Effect.result(store.completeActivation(first, "running", 203)))._tag).toBe("Failure")
        expect(
          Number(
            (yield* Effect.tryPromise(() =>
              db.select({ count: drizzleSql<number>`count(*)` }).from(schema.rikaTurnAdmissionOutbox),
            ))[0]?.count,
          ),
        ).toBe(1)
        yield* store.completeActivation(recovered, "running", 204)
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .select({ status: schema.rikaTurns.status })
              .from(schema.rikaTurns)
              .where(eq(schema.rikaTurns.id, "turn-1")),
          ))[0],
        ).toEqual({ status: "running" })
        expect(
          Number(
            (yield* Effect.all([
              Effect.orDie(
                Effect.tryPromise(() =>
                  db.select({ count: drizzleSql<number>`count(*)` }).from(schema.rikaTurnAdmissionOutbox),
                ),
              ),
              Effect.orDie(
                Effect.tryPromise(() =>
                  db.select({ count: drizzleSql<number>`count(*)` }).from(schema.rikaHostedTurnClaims),
                ),
              ),
            ]))
              .flat()
              .reduce((total, row) => total + Number(row.count), 0),
          ),
        ).toBe(0)
        yield* Effect.tryPromise(() =>
          db.update(schema.rikaTurns).set({ status: "completed" }).where(eq(schema.rikaTurns.id, "turn-1")),
        )
        const second = yield* store.claimNext(request("worker-a", "second-a"))
        if (second === undefined) return yield* Effect.die("Second Turn was not claimed")
        expect(yield* store.claimNext(request("worker-b", "second-b-early"))).toBeUndefined()
        yield* Effect.tryPromise(() =>
          db
            .update(schema.rikaHostedTurnClaims)
            .set({ heartbeatAt: 0, expiresAt: 1 })
            .where(eq(schema.rikaHostedTurnClaims.turnId, "turn-2")),
        )
        const replacement = yield* store.claimNext(request("worker-b", "second-b"))
        if (replacement === undefined) return yield* Effect.die("Expired Turn claim was not recovered")
        expect(yield* store.renew(second, 100)).toBe(false)
        expect(yield* store.renew(replacement, 100)).toBe(true)
        yield* store.release(second)
        const authority = yield* Effect.tryPromise(() =>
          db
            .select({
              workerId: schema.rikaHostedTurnClaims.workerId,
              claimToken: schema.rikaHostedTurnClaims.claimToken,
            })
            .from(schema.rikaHostedTurnClaims)
            .where(eq(schema.rikaHostedTurnClaims.turnId, "turn-2")),
        )
        expect(authority[0]).toEqual({ workerId: "worker-b", claimToken: "second-b" })
        expect(
          yield* store.prepare(replacement, { ...preparedExecution, turnId: "turn-2", runId: "turn-2" }, 301),
        ).toBe(true)
        yield* Effect.tryPromise(() =>
          db
            .update(schema.rikaTurns)
            .set({ status: "cancelled", updatedAt: 302 })
            .where(eq(schema.rikaTurns.id, "turn-2")),
        )
        yield* Effect.tryPromise(() =>
          db
            .update(schema.rikaHostedExecutorAssignments)
            .set({ leaseExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
            .where(eq(schema.rikaHostedExecutorAssignments.id, "assignment-1")),
        )
        yield* Effect.tryPromise(() =>
          db
            .update(schema.rikaHostedTurnClaims)
            .set({ heartbeatAt: 0, expiresAt: 1 })
            .where(eq(schema.rikaHostedTurnClaims.turnId, "turn-2")),
        )
        const cancelledRecovery = yield* store.claimRecovery(request("cancellation", "cancellation-claim"))
        if (cancelledRecovery === undefined) return yield* Effect.die("Cancelled staged admission was not recovered")
        const cancelledLink = { runId: "turn-2", turnId: "turn-2", threadId: "thread-1" }
        expect(cancelledRecovery).toMatchObject({
          preparedExecution: { ...preparedExecution, turnId: "turn-2", runId: "turn-2" },
          input: replacement.input,
        })
        yield* store.completeAdmission(cancelledRecovery, cancelledLink, 303)
        expect(yield* store.requestActivation(cancelledRecovery, 304)).toBe(false)
        yield* store.completeActivation(cancelledRecovery, "cancelled", 305)
        const cancelled = yield* Effect.tryPromise(() =>
          db
            .select({ status: schema.rikaTurns.status, executionLinkJson: schema.rikaTurns.executionLinkJson })
            .from(schema.rikaTurns)
            .where(eq(schema.rikaTurns.id, "turn-2")),
        )
        expect(cancelled[0]).toEqual({ status: "cancelled", executionLinkJson: null })
        expect(
          Number(
            (yield* Effect.tryPromise(() =>
              db
                .select({ count: drizzleSql<number>`count(*)` })
                .from(schema.rikaTurnAdmissionOutbox)
                .where(eq(schema.rikaTurnAdmissionOutbox.turnId, "turn-2")),
            ))[0]?.count,
          ),
        ).toBe(0)
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
})
