import "./recovery.harness"
import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMigrations, identityUser, runMigration } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { FileSystem, Config, Context, DateTime, Effect, Layer, Random, Redacted } from "effect"
import { Prompt } from "effect/unstable/ai"
import { and, asc, eq, ne } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { Address, ExecutableManifest, ExecutableResolver, Message } from "tenetkit/runtime"
import { SqlCodecs } from "tenetkit/runtime/driver/sql"
import { HostedRecovery, layer as hostedRecoveryLayer } from "../../../src/hosted/execution/recovery"
import {
  runOperations as tenetkitRunOperations,
  runs as tenetkitRuns,
} from "../../../src/hosted/execution/tenetkit-schema"
import { live as livePlatform } from "../../support/live-platform"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const principal = { userId: "recovery-user", deviceId: "recovery-device", clientId: "recovery-client" }
const executable = ExecutableManifest.makeTest("recovery", "test")
const executableRef = SqlCodecs.encodeExecutableRef(executable.ref)
const executableManifest = SqlCodecs.encodeExecutableManifest(executable.manifest)
const storedMessage = (suffix: string) =>
  SqlCodecs.encodeMessage(
    Message.make({
      id: `message-${suffix}`,
      to: Address.make("agent:recovery"),
      sessionId: `session-${suffix}`,
      prompt: Prompt.make("recover"),
      idempotencyKey: `run-${suffix}`,
      correlationId: `run-${suffix}`,
    }),
  )

const migrate = (url: string, pool: Pool) =>
  Effect.gen(function* () {
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(migration.url.pathname),
      )
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    yield* ExecutionPostgres.applySchema({ url, source: "hosted-recovery-live" })
  })

it.effect.skipIf(databaseUrl === "")(
  "persists deterministic inspect, retry, accept, and abort resolutions through the TenetKit contract",
  () =>
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
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedWorkspaces).values({
              id: "recovery-workspace",
              ownerId: "recovery-owner",
              createdByUserId: "recovery-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt: now,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedThreads).values({
              id: "recovery-thread",
              ownerId: "recovery-owner",
              workspaceId: "recovery-workspace",
              createdByUserId: "recovery-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt: now,
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
            db.insert(tenetkitRuns).values(
              ["retry", "accept", "abort", "auto"].map((runKind) => ({
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
                respondedWaitIdsJson: "[]",
                createdAt: now,
                updatedAt: now,
              })),
            ),
          )
          yield* Effect.tryPromise(() =>
            db.insert(tenetkitRunOperations).values([
              {
                runId: "run-retry",
                operationId: "tenet-retry",
                operationKey: "operation-retry",
                kind: "tool",
                status: "unknown",
                inputDigest: "retry-digest",
                inputJson: "{}",
                replayPolicy: "pure",
                attempt: 0,
                startedAt: now,
                finishedAt: now,
              },
              {
                runId: "run-accept",
                operationId: "tenet-accept",
                operationKey: "operation-accept",
                kind: "tool",
                status: "unknown",
                inputDigest: "accept-digest",
                inputJson: "{}",
                replayPolicy: "never",
                attempt: 0,
                startedAt: now,
                finishedAt: now,
              },
              {
                runId: "run-abort",
                operationId: "tenet-abort",
                operationKey: "operation-abort",
                kind: "tool",
                status: "unknown",
                inputDigest: "abort-digest",
                inputJson: "{}",
                replayPolicy: "never",
                attempt: 0,
                startedAt: now,
                finishedAt: now,
              },
              {
                runId: "run-auto",
                operationId: "tenet-auto",
                operationKey: "operation-auto",
                kind: "tool",
                status: "unknown",
                inputDigest: "auto-digest",
                inputJson: "{}",
                replayPolicy: "never",
                attempt: 0,
                startedAt: now,
                finishedAt: now,
              },
            ]),
          )
          const deadlineAt = DateTime.toDate(DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"))
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedExecutorOperations).values([
              {
                assignmentId: "recovery-assignment",
                ownerId: "recovery-owner",
                operationKey: "operation-retry",
                requestDigest: "retry-digest",
                code: "retry()",
                attempt: 0,
                state: "dispatched",
                dispatchedGeneration: 1,
                dispatchedLeaseEpoch: 1,
                dispatchedExecutorInstanceId: "executor-recovery",
                dispatchedProcessIncarnation: "process-recovery",
                workspaceId: "recovery-workspace",
                sessionId: "session-recovery",
                threadId: "recovery-thread",
                turnId: "turn-retry",
                runId: "run-retry",
                rootRunId: "run-retry",
                toolCallId: "call-retry",
                replayPolicy: "pure",
                startedAt: now,
                deadlineAt,
              },
              {
                assignmentId: "recovery-assignment",
                ownerId: "recovery-owner",
                operationKey: "operation-accept",
                requestDigest: "accept-digest",
                code: "accept()",
                attempt: 0,
                state: "unknown",
                dispatchedGeneration: 1,
                dispatchedLeaseEpoch: 1,
                dispatchedExecutorInstanceId: "executor-recovery",
                dispatchedProcessIncarnation: "process-recovery",
                response: { _tag: "DomainFailure", failure: { kind: "unknown", message: "unknown" } },
                workspaceId: "recovery-workspace",
                sessionId: "session-recovery",
                threadId: "recovery-thread",
                turnId: "turn-accept",
                runId: "run-accept",
                rootRunId: "run-accept",
                toolCallId: "call-accept",
                replayPolicy: "never",
                startedAt: now,
                deadlineAt,
                terminalOutcome: "unknown",
              },
              {
                assignmentId: "recovery-assignment",
                ownerId: "recovery-owner",
                operationKey: "operation-abort",
                requestDigest: "abort-digest",
                code: "abort()",
                attempt: 0,
                state: "unknown",
                dispatchedGeneration: 1,
                dispatchedLeaseEpoch: 1,
                dispatchedExecutorInstanceId: "executor-recovery",
                dispatchedProcessIncarnation: "process-recovery",
                response: { _tag: "DomainFailure", failure: { kind: "unknown", message: "unknown" } },
                workspaceId: "recovery-workspace",
                sessionId: "session-recovery",
                threadId: "recovery-thread",
                turnId: "turn-abort",
                runId: "run-abort",
                rootRunId: "run-abort",
                toolCallId: "call-abort",
                replayPolicy: "never",
                startedAt: now,
                deadlineAt,
                terminalOutcome: "unknown",
              },
              {
                assignmentId: "recovery-assignment",
                ownerId: "recovery-owner",
                operationKey: "operation-auto",
                requestDigest: "auto-digest",
                code: "6 * 7",
                attempt: 0,
                state: "completed",
                dispatchedGeneration: 1,
                dispatchedLeaseEpoch: 1,
                dispatchedExecutorInstanceId: "executor-recovery",
                dispatchedProcessIncarnation: "process-recovery",
                response: {
                  _tag: "Success",
                  result: {
                    cellId: "call-auto",
                    epoch: 0,
                    sequence: 0,
                    value: "42",
                    stdout: "",
                    stderr: "",
                    durationMillis: 1,
                  },
                },
                workspaceId: "recovery-workspace",
                sessionId: "session-auto",
                threadId: "recovery-thread",
                turnId: "turn-auto",
                runId: "run-auto",
                rootRunId: "run-auto",
                toolCallId: "call-auto",
                replayPolicy: "never",
                startedAt: now,
                deadlineAt,
                terminalOutcome: "completed",
              },
            ]),
          )
          const context = yield* Layer.build(
            hostedRecoveryLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }),
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
                        pollIntervalMillis: 60_000,
                        cancellationIntervalMillis: 60_000,
                      },
                    },
                    resolver: ExecutableResolver.makeStatic([]),
                  }),
                ),
              ),
            ),
          )
          const recovery = Context.get(context, HostedRecovery)
          yield* recovery.reconcileCompleted
          const automaticallyRecovered = (yield* Effect.tryPromise(() =>
            db
              .select({
                status: tenetkitRunOperations.status,
                resolution_idempotency_key: tenetkitRunOperations.resolutionIdempotencyKey,
                resolution_json: tenetkitRunOperations.resolutionJson,
              })
              .from(tenetkitRunOperations)
              .where(eq(tenetkitRunOperations.operationId, "tenet-auto")),
          ))[0]
          expect(automaticallyRecovered).toEqual({
            status: "succeeded",
            resolution_idempotency_key: "tenet-auto:executor-terminal",
            resolution_json:
              '{"_tag":"Succeeded","value":{"_tag":"Success","result":{"cellId":"call-auto","epoch":0,"sequence":0,"value":"42","stdout":"","stderr":"","durationMillis":1},"encodedResult":{"cellId":"call-auto","epoch":0,"sequence":0,"value":"42","stdout":"","stderr":"","durationMillis":1}}}',
          })
          const operations = yield* recovery.inspect({
            principal,
            threadId: "recovery-thread",
            runId: "run-retry",
          })
          expect(operations).toEqual([
            expect.objectContaining({ operationId: "tenet-retry", state: "needs-resolution", started: true }),
          ])
          expect(operations.every((operation) => operation.actions.join(",") === "inspect,retry,accept,abort")).toBe(
            true,
          )
          const retryInput: Parameters<typeof recovery.resolve>[0] = {
            principal,
            threadId: "recovery-thread",
            runId: "run-retry",
            operationId: "tenet-retry",
            idempotencyKey: "resolve-retry",
            resolution: { _tag: "Retry" },
          }
          expect(yield* recovery.resolve(retryInput)).toMatchObject({ state: "retrying", actions: ["inspect"] })
          expect(yield* recovery.resolve(retryInput)).toMatchObject({ state: "retrying", actions: ["inspect"] })
          expect(
            (yield* Effect.result(recovery.resolve({ ...retryInput, idempotencyKey: "conflicting-retry" })))._tag,
          ).toBe("Failure")
          const resolvedAt = DateTime.toDate(DateTime.nowUnsafe())
          yield* Effect.tryPromise(() =>
            db
              .update(tenetkitRunOperations)
              .set({
                status: "succeeded",
                resultJson: '{"answer":42}',
                resolutionIdempotencyKey: "resolve-accept",
                resolutionJson: '{"_tag":"Succeeded","value":{"answer":42}}',
                finishedAt: resolvedAt,
              })
              .where(
                and(
                  eq(tenetkitRunOperations.runId, "run-accept"),
                  eq(tenetkitRunOperations.operationId, "tenet-accept"),
                ),
              ),
          )
          yield* Effect.tryPromise(() =>
            db
              .update(tenetkitRuns)
              .set({ status: "queued", ownerWorkerId: null, updatedAt: resolvedAt })
              .where(eq(tenetkitRuns.runId, "run-accept")),
          )
          expect(
            yield* recovery.resolve({
              ...retryInput,
              runId: "run-accept",
              operationId: "tenet-accept",
              idempotencyKey: "resolve-accept",
              resolution: { _tag: "Accept", value: { answer: 42 } },
            }),
          ).toMatchObject({ state: "accepted", resolution: { _tag: "Accept", value: { answer: 42 } } })
          expect(
            yield* recovery.resolve({
              ...retryInput,
              runId: "run-abort",
              operationId: "tenet-abort",
              idempotencyKey: "resolve-abort",
              resolution: { _tag: "Abort", reason: "operator confirmed failure" },
            }),
          ).toMatchObject({ state: "aborted" })
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
                  operation_id: tenetkitRunOperations.operationId,
                  status: tenetkitRunOperations.status,
                  resolution_idempotency_key: tenetkitRunOperations.resolutionIdempotencyKey,
                  resolution_json: tenetkitRunOperations.resolutionJson,
                })
                .from(tenetkitRunOperations)
                .where(ne(tenetkitRunOperations.operationId, "tenet-auto"))
                .orderBy(asc(tenetkitRunOperations.operationId)),
            ),
          ).toEqual([
            {
              operation_id: "tenet-abort",
              status: "failed",
              resolution_idempotency_key: "resolve-abort",
              resolution_json:
                '{"_tag":"Failed","error":{"_tag":"UserAbortedUnknownOperation","message":"operator confirmed failure"}}',
            },
            {
              operation_id: "tenet-accept",
              status: "succeeded",
              resolution_idempotency_key: "resolve-accept",
              resolution_json: '{"_tag":"Succeeded","value":{"answer":42}}',
            },
            {
              operation_id: "tenet-retry",
              status: "requested",
              resolution_idempotency_key: "resolve-retry",
              resolution_json: '{"_tag":"Retry"}',
            },
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
