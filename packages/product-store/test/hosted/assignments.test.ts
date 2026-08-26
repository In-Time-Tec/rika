import { expect, it } from "@effect/vitest"

import * as BunServices from "@effect/platform-bun/BunServices"
import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import { AssignmentRevision, type WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access, type Version } from "@rika/product/executor-assignments"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
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
import { HostedStore } from "@rika/product/hosted-store"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { sql as drizzleSql } from "drizzle-orm"
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
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const database = `rika_local_recovery_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    const pool = new Pool({ connectionString: url })
    const databaseClient = drizzle({ client: pool })
    try {
      return yield* run({ url, pool, database: databaseClient })
    } finally {
      yield* Effect.tryPromise(() => pool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  })

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
  isolated(({ pool, database }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      yield* seedIdentity(database)
      yield* Effect.tryPromise(() =>
        database
          .insert(schema.rikaHostedOwners)
          .values({ id: "owner-recovery", kind: "organization", organizationId: "organization-recovery" }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(schema.rikaHostedProjects).values({
          id: "project-recovery",
          ownerId: "owner-recovery",
          name: "Recovery",
          createdByUserId: "user-recovery",
          createdAt: drizzleSql`transaction_timestamp()`,
          updatedAt: drizzleSql`transaction_timestamp()`,
        }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(schema.rikaHostedWorkspaces).values({
          id: "workspace-recovery",
          ownerId: "owner-recovery",
          projectId: "project-recovery",
          createdByUserId: "user-recovery",
          executorKind: "runner",
          inheritProjectGrants: false,
          createdAt: drizzleSql`transaction_timestamp()`,
        }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(schema.rikaHostedThreads).values({
          id: "thread-recovery",
          ownerId: "owner-recovery",
          projectId: "project-recovery",
          workspaceId: "workspace-recovery",
          createdByUserId: "user-recovery",
          executorKind: "runner",
          inheritProjectGrants: false,
          createdAt: drizzleSql`transaction_timestamp()`,
        }),
      )
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
    isolated(({ url, pool, database }) =>
      Effect.gen(function* () {
        yield* apply(pool, [...identityMigrations, ...migrations])
        yield* seedIdentity(database)
        const layer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer)
            yield* Effect.gen(function* () {
              const store = yield* HostedStore
              const assignments = yield* ExecutorAssignments
              const owner = yield* store.putOwner({
                id: ids.owner,
                identity: { _tag: "OrganizationOwner", organizationId: ids.organization },
                now: at(0),
              })
              expect(owner).toMatchObject({
                id: ids.owner,
                identity: { _tag: "OrganizationOwner", organizationId: ids.organization },
              })
              yield* store.createProject({
                id: ids.project,
                ownerId: ids.owner,
                name: "Recovery",
                createdByUserId: ids.user,
                now: at(0),
              })
              yield* store.registerDevice({
                id: ids.device,
                userId: ids.user,
                displayName: "Recovery",
                publicKeyFingerprint: "sha256:recovery",
                now: at(0),
              })
              yield* store.authenticateClient({
                id: ids.client,
                userId: ids.user,
                deviceId: ids.device,
                now: at(0),
                expiresAt: at(59),
              })
              yield* store.grantClientAuthority({
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
              yield* store.createWorkspace({
                id: ids.workspace,
                ownerId: ids.owner,
                projectId: ids.project,
                createdByUserId: ids.user,
                executorKind: "runner",
                now: at(0),
              })
              yield* store.createThread({
                id: ids.thread,
                ownerId: ids.owner,
                projectId: ids.project,
                workspaceId: ids.workspace,
                createdByUserId: ids.user,
                executorKind: "runner",
                now: at(0),
              })
              yield* store.admitCommand({
                ownerId: ids.owner,
                threadId: ids.thread,
                commandId: CommandId.make("operation-recovered"),
                idempotencyKey: IdempotencyKey.make("operation-recovered"),
                actor: {
                  _tag: "OrganizationActor",
                  owner: { _tag: "OrganizationOwner", organizationId: ids.organization },
                  userId: ids.user,
                  membershipId: ids.member,
                  clientId: ids.client,
                  deviceId: ids.device,
                },
                command: { _tag: "SubmitPrompt", prompt: "recover" },
                admittedAt: at(1),
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
                commandSequence: Sequence.make("1"),
                event: unknownEvent,
                executorInstanceId: String(access.executorInstanceId),
                processIncarnation: access.processIncarnation,
              }
              const first = yield* store.appendRecoveredEvent(recovered)
              expect(first.event).toEqual(unknownEvent)
              expect(yield* store.appendRecoveredEvent(recovered)).toEqual(first)
              expect(
                (yield* Effect.result(
                  store.appendRecoveredEvent({ ...recovered, assignmentGeneration: FencingGeneration.make("9") }),
                ))._tag,
              ).toBe("Failure")
              expect(
                (yield* Effect.result(
                  store.appendRecoveredEvent({ ...recovered, leaseEpoch: AssignmentLeaseEpoch.make("9") }),
                ))._tag,
              ).toBe("Failure")
              expect(
                (yield* Effect.result(
                  store.appendRecoveredEvent({ ...recovered, executorInstanceId: "other-executor" }),
                ))._tag,
              ).toBe("Failure")
              expect(
                (yield* Effect.result(
                  store.appendRecoveredEvent({ ...recovered, processIncarnation: "other-process" }),
                ))._tag,
              ).toBe("Failure")
            }).pipe(Effect.provideContext(context))
          }),
        )
      }),
    ),
)
