import "../assignments-contract.fixture"
import { expect, it } from "@effect/vitest"

import { type Access, ExecutorAssignments } from "@rika/product/executor-assignments"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedThreadEventStore } from "@rika/product/hosted-thread-event-store"
import { AssignmentLeaseEpoch, EventId, FencingGeneration, IdempotencyKey } from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { sql as drizzleSql } from "drizzle-orm"
import { Effect, Layer, Redacted, Schema } from "effect"
import { identityMigrations } from "../../../../identity/src/database/migrations"
import { runMigration } from "../../../../identity/src/database/postgres"
import * as schema from "../../../src/database/schema/product"
import { migrations } from "../../../src/hosted/migrations"
import * as HostedPostgres from "../../../src/hosted/layer"
import {
  apply,
  at,
  capabilities,
  ids,
  isolated,
  live,
  readFileString,
  seedIdentity,
  seedRecoveryAggregate,
  unknownEvent,
  version,
} from "../assignments.support"

it.effect.skipIf(!live)("applies Runner migrations idempotently and inspects recovery constraints", () =>
  isolated(({ pool }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      for (const migration of [...identityMigrations, ...migrations]) {
        const sql = yield* readFileString(migration.url)
        expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
      }
      const constraints = yield* Effect.tryPromise(() =>
        pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'rika_hosted_executor_operations'::regclass
          ORDER BY conname`),
      )
      const constraintDefinitions = constraints.rows.map((row: { definition: string }) => row.definition)
      expect(
        constraintDefinitions.some((definition) => definition.includes("dispatched_executor_instance_id IS NOT NULL")),
      ).toBe(true)
      expect(constraintDefinitions.some((definition) => definition.includes("dispatch_deadline_at"))).toBe(false)
      const indexes = yield* Effect.tryPromise(() =>
        pool.query(`SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'rika_hosted_executor_operations'
          ORDER BY indexname`),
      )
      const recoveryIndex = yield* Schema.decodeUnknownEffect(Schema.Struct({ indexdef: Schema.String }))(
        indexes.rows.find((row: { indexname: string }) => row.indexname === "rika_hosted_executor_operations_recovery"),
      )
      expect(recoveryIndex.indexdef).toContain("(state, deadline_at)")
      expect(recoveryIndex.indexdef).toContain("WHERE (state = 'dispatched'")
      const definitionResult = yield* Effect.tryPromise(() =>
        pool.query(`SELECT pg_get_functiondef('rika_hosted_validate_executor_fence'::regproc) AS definition`),
      )
      const definition = yield* Schema.decodeUnknownEffect(Schema.Struct({ definition: Schema.String }))(
        definitionResult.rows[0],
      )
      expect(definition.definition).toContain("state = 'unknown'")
      expect(definition.definition).toContain("dispatched_executor_instance_id = NEW.executor_instance_id")
      expect(definition.definition).toContain("clock_timestamp()")
    }),
  ),
)

it.effect.skipIf(!live)("fails closed when a dispatched operation has no reconstructable fence", () =>
  isolated(({ pool, database, effectDatabase }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      yield* seedIdentity(database)
      yield* seedRecoveryAggregate(effectDatabase)
      yield* Effect.tryPromise(() =>
        database.insert(schema.rikaHostedExecutorAssignments).values({
          id: "assignment-recovery",
          ownerId: "owner-recovery",
          threadId: "thread-recovery",
          workspaceId: "workspace-recovery",
          executorKind: "runner",
          placement: { _tag: "RunnerPlacement", deviceId: "device-recovery" },
          generation: 2,
          revision: 1,
          lastLeaseEpoch: 2,
          lifecycle: "active",
          providerInstanceId: "device-recovery",
          executorInstanceId: "executor-recovery",
          processIncarnation: "process-recovery",
          sessionDigest: "session-digest",
          leaseEpoch: 2,
          leaseExpiresAt: drizzleSql`transaction_timestamp() + interval '5 minutes'`,
        }),
      )
      const failed = yield* Effect.tryPromise(() =>
        pool.query(
          `INSERT INTO rika_hosted_executor_operations
          (assignment_id, owner_id, operation_key, request_digest, code, attempt, state, dispatched_generation, dispatched_lease_epoch)
          VALUES ('assignment-recovery', 'owner-recovery', 'unfenced-dispatch', 'digest', 'printf 1', 0, 'dispatched', 1, 1)`,
        ),
      ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }))
      expect(failed).toBe(true)
    }),
  ),
)

it.effect.skipIf(!live)(
  "accepts an exact old-fence recovered event and rejects the wrong generation, lease, executor, and process",
  () =>
    isolated(({ url, pool, database, effectDatabase }) =>
      Effect.gen(function* () {
        yield* apply(pool, [...identityMigrations, ...migrations])
        yield* seedIdentity(database)
        yield* seedRecoveryAggregate(effectDatabase)
        const layer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer)
            yield* Effect.gen(function* () {
              const authority = yield* HostedClientAuthority
              const ledger = yield* HostedThreadEventStore
              const assignments = yield* ExecutorAssignments
              yield* authority.registerDevice({
                id: ids.device,
                userId: ids.user,
                displayName: "Recovery",
                publicKeyFingerprint: "sha256:recovery",
                now: at(0),
              })
              yield* authority.authenticateClient({
                id: ids.client,
                userId: ids.user,
                deviceId: ids.device,
                now: at(0),
                expiresAt: at(59),
              })
              yield* authority.grantClientAuthority({
                ownerId: ids.owner,
                actor: {
                  _tag: "OrganizationActor",
                  owner: { _tag: "OrganizationOwner", organizationId: ids.organization },
                  userId: ids.user,
                  membershipId: ids.member,
                  clientId: ids.client,
                  deviceId: ids.device,
                },
                now: at(0),
                expiresAt: at(59),
              })
              const created = yield* assignments.create({
                id: ids.assignment,
                ownerId: ids.owner,
                threadId: ids.thread,
                workspaceId: ids.workspace,
                placement: {
                  _tag: "RunnerPlacement",
                  deviceId: ids.device,
                  checkoutFingerprint: CheckoutFingerprint.make("recovery-checkout"),
                  requestingDeviceId: ids.device,
                },
                checkout: null,
              })
              const provisioning = yield* assignments.beginProvisioning({
                ...version(created),
                bootstrapCredentialDigest: Redacted.make("bootstrap"),
                bootstrapLifetimeMillis: 60_000,
              })
              const bound = yield* assignments.bindProviderInstance({
                ...version(provisioning),
                providerInstanceId: ids.device,
              })
              const active = yield* assignments.openSession({
                ...version(bound),
                providerInstanceId: ids.device,
                executorInstanceId: ids.executor,
                processIncarnation: "process-recovery",
                capabilities,
                presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
                sessionCredentialDigest: Redacted.make("session"),
                leaseLifetimeMillis: 60_000,
              })
              if (active.lifecycle._tag !== "Active") return yield* Effect.die("assignment did not become active")
              const access: Access = {
                assignmentId: active.id,
                assignmentGeneration: active.generation,
                providerInstanceId: active.lifecycle.providerInstanceId,
                executorInstanceId: active.lifecycle.executorInstanceId,
                processIncarnation: active.lifecycle.processIncarnation,
                leaseEpoch: active.lifecycle.leaseEpoch,
                presentedSessionCredentialDigest: Redacted.make("session"),
              }
              yield* Effect.tryPromise(() =>
                database.insert(schema.rikaHostedExecutorOperations).values({
                  assignmentId: access.assignmentId,
                  ownerId: ids.owner,
                  operationKey: "operation-recovered",
                  requestDigest: "digest",
                  workspaceId: "workspace-recovery",
                  sessionId: "thread-recovery",
                  threadId: "thread-recovery",
                  turnId: "turn-recovery",
                  runId: "run-recovery",
                  rootRunId: "run-recovery",
                  toolCallId: "call-recovery",
                  code: "printf recover",
                  attempt: 0,
                  deadlineAt: drizzleSql`'2999-01-01T00:00:00.000Z'::timestamptz`,
                  state: "unknown",
                  dispatchedGeneration: Number(access.assignmentGeneration),
                  dispatchedLeaseEpoch: Number(access.leaseEpoch),
                  dispatchedExecutorInstanceId: access.executorInstanceId,
                  dispatchedProcessIncarnation: access.processIncarnation,
                  response: unknownEvent.response,
                  terminalOutcome: "unknown",
                }),
              )
              const recovered = {
                eventId: EventId.make("operation-recovered"),
                idempotencyKey: IdempotencyKey.make("operation-recovered"),
                assignmentId: access.assignmentId,
                assignmentGeneration: access.assignmentGeneration,
                leaseEpoch: access.leaseEpoch,
                commandSequence: null,
                event: unknownEvent,
                executorInstanceId: String(access.executorInstanceId),
                processIncarnation: access.processIncarnation,
              }
              const first = yield* ledger.appendRecoveredEvent(recovered)
              expect(first.event).toEqual(unknownEvent)
              expect(yield* ledger.appendRecoveredEvent(recovered)).toEqual(first)
              expect(
                yield* Effect.result(
                  ledger.appendRecoveredEvent({ ...recovered, assignmentGeneration: FencingGeneration.make("9") }),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
              expect(
                yield* Effect.result(
                  ledger.appendRecoveredEvent({ ...recovered, leaseEpoch: AssignmentLeaseEpoch.make("9") }),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
              expect(
                yield* Effect.result(
                  ledger.appendRecoveredEvent({ ...recovered, executorInstanceId: "other-executor" }),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
              expect(
                yield* Effect.result(
                  ledger.appendRecoveredEvent({ ...recovered, processIncarnation: "other-process" }),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
            }).pipe(Effect.provideContext(context))
          }),
        )
      }),
    ),
)
