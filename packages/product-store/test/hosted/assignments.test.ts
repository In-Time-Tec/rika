import { expect, it } from "@effect/vitest"

import * as BunServices from "@effect/platform-bun/BunServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import {
  AssignmentRevision,
  type ExecutorAssignment,
  type WorkspaceCapabilitySnapshot,
} from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access, type Version } from "@rika/product/executor-assignments"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedThreadEventStore } from "@rika/product/hosted-thread-event-store"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CheckpointId,
  DeviceId,
  EventId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  IdempotencyKey,
  AssignmentLeaseEpoch,
  OrganizationId,
  OwnerId,
  ProjectId,
  Sequence,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { eq, sql as drizzleSql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Config, Effect, FileSystem, Layer, Random, Redacted, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { runMigration } from "../../../identity/src/database/postgres"
import * as schema from "../../src/database/schema/product"
import { migrations } from "../../src/hosted/migrations"
import * as HostedPostgres from "../../src/hosted/layer"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
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
const at = (second: number) => Timestamp.make(`2099-01-01T00:00:${String(second).padStart(2, "0")}.000Z`)
const capabilities: WorkspaceCapabilitySnapshot = {
  environmentDigest: `sha256:${"a".repeat(64)}`,
  capturedAt: at(0),
  filesystem: { _tag: "Ready", detail: "workspace filesystem" },
  typescriptKernel: { _tag: "Ready", detail: "TypeScript kernel" },
  git: { _tag: "Ready", detail: "git" },
  process: { _tag: "Ready", detail: "process execution" },
  pty: { _tag: "Ready", detail: "PTY" },
  browser: { _tag: "Unavailable", reason: "browser not installed" },
  services: { _tag: "Unavailable", reason: "repository services unavailable" },
  workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle" },
}
const unknownEvent = {
  _tag: "CellResult",
  operationKey: "operation-recovered",
  response: {
    _tag: "DomainFailure",
    failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
  },
}

const ids = {
  client: ClientId.make("client-recovery"),
  device: DeviceId.make("device-recovery"),
  executor: ExecutorInstanceId.make("executor-recovery"),
  member: BetterAuthMemberId.make("member-recovery"),
  organization: OrganizationId.make("organization-recovery"),
  owner: OwnerId.make("owner-recovery"),
  project: ProjectId.make("project-recovery"),
  thread: ThreadId.make("thread-recovery"),
  user: BetterAuthUserId.make("user-recovery"),
  workspace: WorkspaceId.make("workspace-recovery"),
  assignment: ExecutorAssignmentId.make("assignment-recovery"),
}

const version = (assignment: {
  readonly id: string
  readonly generation: string
  readonly revision: string
}): Version => ({
  assignmentId: ExecutorAssignmentId.make(assignment.id),
  generation: FencingGeneration.make(assignment.generation),
  revision: AssignmentRevision.make(assignment.revision),
})

const apply = (
  pool: Pool,
  selected: ReadonlyArray<(typeof migrations)[number] | (typeof identityMigrations)[number]>,
) =>
  Effect.gen(function* () {
    for (const migration of selected) {
      const sql = yield* readFileString(migration.url)
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(true)
    }
  })

const isolated = <A, E, R>(
  run: (input: {
    readonly url: string
    readonly pool: Pool
    readonly database: NodePgDatabase
    readonly effectDatabase: PgDrizzle.EffectPgDatabase
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_local_recovery_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const databaseClient = drizzle({ client: pool })
      const context = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
      const effectDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(context))
      try {
        return yield* run({ url, pool, database: databaseClient, effectDatabase })
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  )

const seedIdentity = (database: NodePgDatabase) =>
  Effect.gen(function* () {
    const now = drizzleSql`transaction_timestamp()`
    yield* Effect.tryPromise(() =>
      database.insert(identityUser).values({
        id: "user-recovery",
        name: "Recovery",
        email: "recovery@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      database.insert(identityOrganization).values({
        id: "organization-recovery",
        name: "Recovery",
        slug: "recovery",
        createdAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      database.insert(identityMember).values({
        id: "member-recovery",
        organizationId: "organization-recovery",
        userId: "user-recovery",
        role: "owner",
        createdAt: now,
      }),
    )
  })

const seedRecoveryAggregate = (database: PgDrizzle.EffectPgDatabase) =>
  database.transaction((tx) =>
    Effect.gen(function* () {
      const now = drizzleSql`transaction_timestamp()`
      yield* tx
        .insert(schema.rikaHostedOwners)
        .values({ id: ids.owner, kind: "organization", organizationId: ids.organization })
      yield* tx.insert(schema.rikaHostedOwnerCounters).values({ ownerId: ids.owner })
      yield* tx.insert(schema.rikaHostedProjects).values({
        id: ids.project,
        ownerId: ids.owner,
        name: "Recovery",
        createdByUserId: ids.user,
        createdAt: now,
        updatedAt: now,
      })
      yield* tx.insert(schema.rikaHostedWorkspaces).values({
        id: ids.workspace,
        ownerId: ids.owner,
        projectId: ids.project,
        createdByUserId: ids.user,
        executorKind: "runner",
        inheritProjectGrants: false,
        createdAt: now,
      })
      yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: ids.owner, path: ids.workspace, createdAt: 1 })
      yield* tx.insert(schema.rikaHostedThreads).values({
        id: ids.thread,
        ownerId: ids.owner,
        projectId: ids.project,
        workspaceId: ids.workspace,
        createdByUserId: ids.user,
        executorKind: "runner",
        inheritProjectGrants: false,
        createdAt: now,
      })
      yield* tx.insert(schema.rikaThreads).values({
        id: ids.thread,
        ownerId: ids.owner,
        workspace: ids.workspace,
        title: "Recovery",
        createdAt: 1,
        updatedAt: 1,
      })
    }),
  )

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
      const definition = yield* Effect.tryPromise(() =>
        pool.query(`SELECT pg_get_functiondef('rika_hosted_validate_executor_fence'::regproc) AS definition`),
      )
      expect(definition.rows[0]?.definition).toContain("state = 'unknown'")
      expect(definition.rows[0]?.definition).toContain("dispatched_executor_instance_id = NEW.executor_instance_id")
      expect(definition.rows[0]?.definition).toContain("clock_timestamp()")
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

it.effect.skipIf(!live)("enforces the executor assignment contract with PostgreSQL time and fences", () =>
  isolated(({ pool, database, effectDatabase, url }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      yield* seedIdentity(database)
      yield* seedRecoveryAggregate(effectDatabase)
      const suffixes = [
        "session",
        "checkpoint",
        "replacement",
        "authority",
        "capabilities",
        "no-checkout",
        "expired-bootstrap",
        "expired-lease",
      ] as const
      yield* effectDatabase.transaction((tx) =>
        Effect.forEach(
          suffixes,
          (suffix) =>
            Effect.gen(function* () {
              const now = drizzleSql`transaction_timestamp()`
              const workspaceId = `workspace-${suffix}`
              const threadId = `thread-${suffix}`
              yield* tx.insert(schema.rikaHostedWorkspaces).values({
                id: workspaceId,
                ownerId: ids.owner,
                projectId: null,
                createdByUserId: ids.user,
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              })
              yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: ids.owner, path: workspaceId, createdAt: 1 })
              yield* tx.insert(schema.rikaHostedThreads).values({
                id: threadId,
                ownerId: ids.owner,
                projectId: null,
                workspaceId,
                createdByUserId: ids.user,
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              })
              yield* tx.insert(schema.rikaThreads).values({
                id: threadId,
                ownerId: ids.owner,
                workspace: workspaceId,
                title: suffix,
                createdAt: 1,
                updatedAt: 1,
              })
            }),
          { discard: true },
        ),
      )

      const layer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          yield* Effect.gen(function* () {
            const assignments = yield* ExecutorAssignments
            const capabilitiesFor = (digestCharacter: string): WorkspaceCapabilitySnapshot => ({
              ...capabilities,
              environmentDigest: `sha256:${digestCharacter.repeat(64)}`,
            })
            const open = (suffix: (typeof suffixes)[number]) =>
              Effect.gen(function* () {
                const before = yield* Effect.tryPromise(() =>
                  pool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now"),
                )
                const created = yield* assignments.create({
                  id: ExecutorAssignmentId.make(`assignment-${suffix}`),
                  ownerId: ids.owner,
                  threadId: ThreadId.make(`thread-${suffix}`),
                  workspaceId: WorkspaceId.make(`workspace-${suffix}`),
                  placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
                  checkout: null,
                })
                const after = yield* Effect.tryPromise(() =>
                  pool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now"),
                )
                const createdAt = Date.parse(created.createdAt)
                expect(createdAt).toBeGreaterThanOrEqual(before.rows[0]!.now.getTime())
                expect(createdAt).toBeLessThanOrEqual(after.rows[0]!.now.getTime())
                const provisioning = yield* assignments.beginProvisioning({
                  ...version(created),
                  bootstrapCredentialDigest: Redacted.make("bootstrap"),
                  bootstrapLifetimeMillis: 60_000,
                })
                const bound = yield* assignments.bindProviderInstance({
                  ...version(provisioning),
                  providerInstanceId: `sandbox-${suffix}`,
                })
                const active = yield* assignments.openSession({
                  ...version(bound),
                  providerInstanceId: `sandbox-${suffix}`,
                  executorInstanceId: ids.executor,
                  processIncarnation: `process-${suffix}`,
                  capabilities: capabilitiesFor("a"),
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
                return { bound, active, access }
              })

            const session = yield* open("session")
            expect(yield* assignments.getForThread(ThreadId.make("thread-session"))).toEqual(session.active)
            expect(session.active).not.toHaveProperty("bootstrapCredentialDigest")
            expect(session.active).not.toHaveProperty("sessionCredentialDigest")
            const bootstrapReplay = yield* Effect.result(
              assignments.openSession({
                ...version(session.active),
                providerInstanceId: "sandbox-session",
                executorInstanceId: ids.executor,
                processIncarnation: "process-session",
                capabilities: capabilitiesFor("b"),
                presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
                sessionCredentialDigest: Redacted.make("another-session"),
                leaseLifetimeMillis: 60_000,
              }),
            )
            expect(bootstrapReplay).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
            const reconnected = yield* assignments.reconnect({ access: session.access, leaseLifetimeMillis: 60_000 })
            expect(reconnected.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "2" })
            expect(yield* Effect.result(assignments.authenticate(session.access))).toMatchObject({
              _tag: "Failure",
              failure: { reason: "stale-fence" },
            })
            expect(AssignmentRevision.make(session.bound.revision)).toBe("2")

            const checkpointSession = yield* open("checkpoint")
            const cursor = { sequence: Sequence.make("1"), value: "event-1" }
            yield* assignments.heartbeat({ access: checkpointSession.access, cursor, leaseLifetimeMillis: 60_000 })
            const checkpointInput = {
              access: checkpointSession.access,
              id: CheckpointId.make("checkpoint-contract"),
              objectKey: "checkpoints/checkpoint.tar.zst",
              contentDigest: `sha256:${"a".repeat(64)}`,
              sizeBytes: 1024,
              format: "tar.zst" as const,
              cursor,
              metadata: { source: "filesystem" },
            }
            const checkpoint = yield* assignments.commitCheckpoint(checkpointInput)
            expect(yield* assignments.commitCheckpoint(checkpointInput)).toEqual(checkpoint)
            expect(yield* assignments.latestCheckpoint(checkpointSession.active.id)).toEqual(checkpoint)
            expect(
              yield* Effect.result(
                assignments.commitCheckpoint({ ...checkpointInput, sizeBytes: checkpointInput.sizeBytes + 1 }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
            expect(
              yield* Effect.result(
                assignments.heartbeat({
                  access: checkpointSession.access,
                  cursor: { sequence: Sequence.make("0"), value: "" },
                  leaseLifetimeMillis: 60_000,
                }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })

            const replacementSession = yield* open("replacement")
            if (replacementSession.active.placement._tag !== "OrbPlacement")
              return yield* Effect.die("assignment is not placed in an Orb")
            const replacement = yield* assignments.beginReplacement({
              ...version(replacementSession.active),
              placement: { ...replacementSession.active.placement, templateBuildId: "template-v2" },
              bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect(replacement).toMatchObject({
              generation: "2",
              capabilityGeneration: null,
              capabilities: null,
              lifecycle: { _tag: "Provisioning", providerInstanceId: null },
            })
            expect(yield* Effect.result(assignments.authenticate(replacementSession.access))).toMatchObject({
              _tag: "Failure",
              failure: { reason: "stale-fence" },
            })

            const authoritySession = yield* open("authority")
            const unauthorizedPlacements: ReadonlyArray<ExecutorAssignment["placement"]> = [
              { _tag: "OrbPlacement", templateBuildId: "template-v2", providerScope: "another-scope" },
              {
                _tag: "RunnerPlacement",
                deviceId: DeviceId.make("another-device"),
                checkoutFingerprint: CheckoutFingerprint.make("another-checkout"),
                requestingDeviceId: DeviceId.make("another-requester"),
              },
            ]
            for (const placement of unauthorizedPlacements)
              expect(
                yield* Effect.result(
                  assignments.beginReplacement({
                    ...version(authoritySession.active),
                    placement,
                    bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
                    bootstrapLifetimeMillis: 60_000,
                  }),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })

            const capabilitySession = yield* open("capabilities")
            const refreshedCapabilities = capabilitiesFor("c")
            const updated = yield* assignments.updateCapabilities({
              access: capabilitySession.access,
              capabilities: refreshedCapabilities,
            })
            expect(updated.capabilityGeneration).toBe(updated.generation)
            expect(updated.capabilities).toEqual(refreshedCapabilities)
            const paused = yield* assignments.pause(version(updated))
            expect(paused.capabilities).toEqual(refreshedCapabilities)
            const capabilityReplacement = yield* assignments.beginReplacement({
              ...version(paused),
              placement: paused.placement,
              bootstrapCredentialDigest: Redacted.make("replacement-capabilities"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect(capabilityReplacement).toMatchObject({ capabilityGeneration: null, capabilities: null })

            expect((yield* open("no-checkout")).active.checkout).toBeNull()

            const expiredBootstrapCreated = yield* assignments.create({
              id: ExecutorAssignmentId.make("assignment-expired-bootstrap"),
              ownerId: ids.owner,
              threadId: ThreadId.make("thread-expired-bootstrap"),
              workspaceId: WorkspaceId.make("workspace-expired-bootstrap"),
              placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
              checkout: null,
            })
            const expiredProvisioning = yield* assignments.beginProvisioning({
              ...version(expiredBootstrapCreated),
              bootstrapCredentialDigest: Redacted.make("expired-bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            const expiredBound = yield* assignments.bindProviderInstance({
              ...version(expiredProvisioning),
              providerInstanceId: "sandbox-expired",
            })
            yield* Effect.tryPromise(() =>
              database
                .update(schema.rikaHostedExecutorAssignments)
                .set({ bootstrapExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, expiredBound.id)),
            )
            expect(yield* assignments.isBootstrapLive(version(expiredBound))).toBe(false)
            expect(
              yield* Effect.result(
                assignments.openSession({
                  ...version(expiredBound),
                  providerInstanceId: "sandbox-expired",
                  executorInstanceId: ids.executor,
                  processIncarnation: "expired",
                  capabilities: capabilitiesFor("d"),
                  presentedBootstrapCredentialDigest: Redacted.make("expired-bootstrap"),
                  sessionCredentialDigest: Redacted.make("expired-session"),
                  leaseLifetimeMillis: 60_000,
                }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })

            const expiredLease = yield* open("expired-lease")
            yield* Effect.tryPromise(() =>
              database
                .update(schema.rikaHostedExecutorAssignments)
                .set({ leaseExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, expiredLease.active.id)),
            )
            expect(yield* Effect.result(assignments.authenticate(expiredLease.access))).toMatchObject({
              _tag: "Failure",
              failure: { reason: "stale-fence" },
            })
            const renewed = yield* assignments.reconnect({ access: expiredLease.access, leaseLifetimeMillis: 60_000 })
            expect(renewed.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "2" })
          }).pipe(Effect.provideContext(context))
        }),
      )
    }),
  ),
)
