import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMigrations, runMigration } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { FileSystem, Config, Context, Effect, Layer, Random, Redacted } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Pool } from "pg"
import { Address, ExecutableManifest, ExecutableResolver, Message } from "tenetkit/runtime"
import { encodeExecutableManifest, encodeExecutableRef, encodeMessage } from "tenetkit/runtime/driver/sql/codecs"
import { HostedRecovery, layer as hostedRecoveryLayer } from "../src/hosted-recovery"
import { live as livePlatform } from "./live-platform"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const principal = { userId: "recovery-user", deviceId: "recovery-device", clientId: "recovery-client" }
const executable = ExecutableManifest.makeTest("recovery", "test")
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`
const executableRef = sqlText(encodeExecutableRef(executable.ref))
const executableManifest = sqlText(encodeExecutableManifest(executable.manifest))
const storedMessage = (suffix: string) =>
  sqlText(
    encodeMessage(
      Message.make({
        id: `message-${suffix}`,
        to: Address.make("agent:recovery"),
        sessionId: `session-${suffix}`,
        prompt: Prompt.make("recover"),
        idempotencyKey: `run-${suffix}`,
        correlationId: `run-${suffix}`,
      }),
    ),
  )

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.tryPromise(() => pool.query(text, [...values]))

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

const seed = (pool: Pool) =>
  query(
    pool,
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('recovery-user', 'Recovery', 'recovery@example.test', true, now(), now()),
        ('other-user', 'Other', 'other@example.test', true, now(), now());
    INSERT INTO rika_hosted_owners (id, kind, user_id)
      VALUES ('recovery-owner', 'personal', 'recovery-user');
    INSERT INTO rika_hosted_workspaces
      (id, owner_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
      VALUES ('recovery-workspace', 'recovery-owner', 'recovery-user', 'orb', false, now());
    INSERT INTO rika_hosted_threads
      (id, owner_id, workspace_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
      VALUES ('recovery-thread', 'recovery-owner', 'recovery-workspace', 'recovery-user', 'orb', false, now());
    INSERT INTO rika_hosted_executor_assignments
      (id, owner_id, thread_id, workspace_id, executor_kind, placement, generation, revision,
        last_lease_epoch, lifecycle, provider_instance_id, executor_instance_id, process_incarnation,
        session_digest, lease_epoch, lease_expires_at)
      VALUES ('recovery-assignment', 'recovery-owner', 'recovery-thread', 'recovery-workspace', 'orb',
        '{"_tag":"OrbPlacement","templateBuildId":"build-recovery"}'::jsonb, 1, 1, 1, 'active',
        'provider-recovery', 'executor-recovery', 'process-recovery', 'session-recovery', 1,
        now() + interval '5 minutes');
    INSERT INTO tenetkit_runs
      (run_id, status, address, session_id, message_id, message_json, message_digest, idempotency_key,
        executable_ref_json, executable_manifest_json, root_run_id, depth, max_depth, max_subagents,
        accepted_sequence, responded_wait_ids_json, created_at, updated_at)
      VALUES
        ('run-retry', 'needs-resolution', 'agent:recovery', 'session-retry', 'message-retry',
          ${storedMessage("retry")}, 'retry-message-digest', 'run-retry', ${executableRef}, ${executableManifest},
          'run-retry', 0, 8, 8, 1, '[]', now(), now()),
        ('run-accept', 'needs-resolution', 'agent:recovery', 'session-accept', 'message-accept',
          ${storedMessage("accept")}, 'accept-message-digest', 'run-accept', ${executableRef}, ${executableManifest},
          'run-accept', 0, 8, 8, 1, '[]', now(), now()),
        ('run-abort', 'needs-resolution', 'agent:recovery', 'session-abort', 'message-abort',
          ${storedMessage("abort")}, 'abort-message-digest', 'run-abort', ${executableRef}, ${executableManifest},
          'run-abort', 0, 8, 8, 1, '[]', now(), now());
    INSERT INTO tenetkit_run_operations
      (run_id, operation_id, operation_key, kind, status, input_digest, input_json, replay_policy,
        attempt, started_at, finished_at)
      VALUES
        ('run-retry', 'tenet-retry', 'operation-retry', 'tool', 'unknown', 'retry-digest', '{}',
          'pure', 0, now(), now()),
        ('run-accept', 'tenet-accept', 'operation-accept', 'tool', 'unknown', 'accept-digest', '{}',
          'never', 0, now(), now()),
        ('run-abort', 'tenet-abort', 'operation-abort', 'tool', 'unknown', 'abort-digest', '{}',
          'never', 0, now(), now());
    INSERT INTO rika_hosted_executor_operations
      (assignment_id, owner_id, operation_key, request_digest, code, attempt, state,
        dispatched_generation, dispatched_lease_epoch, dispatched_executor_instance_id,
        dispatched_process_incarnation, response, workspace_id, session_id, thread_id, turn_id,
        run_id, root_run_id, tool_call_id, replay_policy, started_at, resolution_state, deadline_at,
        terminal_outcome)
      VALUES
        ('recovery-assignment', 'recovery-owner', 'operation-retry', 'retry-digest', 'retry()', 0, 'unknown',
          1, 1, 'executor-recovery', 'process-recovery',
          '{"_tag":"DomainFailure","failure":{"kind":"unknown","message":"unknown"}}'::jsonb,
          'recovery-workspace', 'session-recovery', 'recovery-thread', 'turn-retry', 'run-retry',
          'run-retry', 'call-retry', 'pure', now(), 'pending', '2999-01-01T00:00:00.000Z', 'unknown'),
        ('recovery-assignment', 'recovery-owner', 'operation-accept', 'accept-digest', 'accept()', 0, 'unknown',
          1, 1, 'executor-recovery', 'process-recovery',
          '{"_tag":"DomainFailure","failure":{"kind":"unknown","message":"unknown"}}'::jsonb,
          'recovery-workspace', 'session-recovery', 'recovery-thread', 'turn-accept', 'run-accept',
          'run-accept', 'call-accept', 'never', now(), 'pending', '2999-01-01T00:00:00.000Z', 'unknown'),
        ('recovery-assignment', 'recovery-owner', 'operation-abort', 'abort-digest', 'abort()', 0, 'unknown',
          1, 1, 'executor-recovery', 'process-recovery',
          '{"_tag":"DomainFailure","failure":{"kind":"unknown","message":"unknown"}}'::jsonb,
          'recovery-workspace', 'session-recovery', 'recovery-thread', 'turn-abort', 'run-abort',
          'run-abort', 'call-abort', 'never', now(), 'pending', '2999-01-01T00:00:00.000Z', 'unknown')`,
  )

it.effect.skipIf(databaseUrl === "")(
  "persists deterministic inspect, retry, accept, and abort resolutions through the TenetKit contract",
  () =>
    livePlatform(
      Effect.gen(function* () {
        const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
        const database = `rika_hosted_recovery_${suffix}`
        const admin = new Pool({ connectionString: databaseUrl })
        yield* query(admin, `CREATE DATABASE "${database}"`)
        const parsed = new URL(databaseUrl)
        parsed.pathname = `/${database}`
        const url = parsed.toString()
        const pool = new Pool({ connectionString: url })
        try {
          yield* migrate(url, pool)
          yield* seed(pool)
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
          const retryInput = {
            principal,
            threadId: "recovery-thread",
            runId: "run-retry",
            operationId: "tenet-retry",
            idempotencyKey: "resolve-retry",
            resolution: { _tag: "Retry" as const },
          }
          expect(yield* recovery.resolve(retryInput)).toMatchObject({ state: "retrying", actions: ["inspect"] })
          expect(yield* recovery.resolve(retryInput)).toMatchObject({ state: "retrying", actions: ["inspect"] })
          expect(
            (yield* Effect.result(recovery.resolve({ ...retryInput, idempotencyKey: "conflicting-retry" })))._tag,
          ).toBe("Failure")
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
            (yield* query(
              pool,
              `SELECT operation_key, resolution_state, resolution_idempotency_key, resolution
                FROM rika_hosted_executor_operations ORDER BY operation_key`,
            )).rows,
          ).toEqual([
            {
              operation_key: "operation-abort",
              resolution_state: "aborted",
              resolution_idempotency_key: "resolve-abort",
              resolution: { _tag: "Abort", reason: "operator confirmed failure" },
            },
            {
              operation_key: "operation-accept",
              resolution_state: "accepted",
              resolution_idempotency_key: "resolve-accept",
              resolution: { _tag: "Accept", value: { answer: 42 } },
            },
            {
              operation_key: "operation-retry",
              resolution_state: "retrying",
              resolution_idempotency_key: "resolve-retry",
              resolution: { _tag: "Retry" },
            },
          ])
          expect(
            (yield* query(
              pool,
              `SELECT operation_id, status, resolution_idempotency_key, resolution_json
                FROM tenetkit_run_operations ORDER BY operation_id`,
            )).rows,
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
