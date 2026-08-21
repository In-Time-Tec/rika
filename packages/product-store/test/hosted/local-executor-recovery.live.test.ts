import { expect, it } from "@effect/vitest"
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
import { CheckoutFingerprint } from "@rika/product/local-runner-registration"
import { Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/migrations"
import { runMigration } from "../../../identity/src/postgres"
import { migrations } from "../../src/hosted/migrations"
import * as HostedPostgres from "../../src/hosted/postgres-layer"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
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
  assignment: ExecutorAssignmentId.make("thread-recovery"),
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
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(true)
    }
  })

const isolated = <A, E, R>(run: (input: { readonly url: string; readonly pool: Pool }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = `rika_local_recovery_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl!)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    const pool = new Pool({ connectionString: url })
    try {
      return yield* run({ url, pool })
    } finally {
      yield* Effect.promise(() => pool.end())
      yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.promise(() => admin.end())
    }
  })

const seedIdentity = (pool: Pool) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('user-recovery', 'Recovery', 'recovery@example.test', true, now(), now())`),
    )
    yield* Effect.promise(() =>
      pool.query(`INSERT INTO "organization" (id, name, slug, created_at)
        VALUES ('organization-recovery', 'Recovery', 'recovery', now())`),
    )
    yield* Effect.promise(() =>
      pool.query(`INSERT INTO member (id, organization_id, user_id, role, created_at)
        VALUES ('member-recovery', 'organization-recovery', 'user-recovery', 'owner', now())`),
    )
  })

it.effect.skipIf(!live)("applies local executor migrations idempotently and inspects recovery constraints", () =>
  isolated(({ pool }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      for (const migration of [...identityMigrations, ...migrations]) {
        const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
        expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
      }
      const constraints = yield* Effect.promise(() =>
        pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'rika_hosted_executor_operations'::regclass
          ORDER BY conname`),
      )
      const constraintDefinitions = constraints.rows.map((row: { definition: string }) => row.definition)
      expect(
        constraintDefinitions.some((definition) => definition.includes("dispatched_executor_instance_id IS NOT NULL")),
      ).toBe(true)
      expect(constraintDefinitions.some((definition) => definition.includes("dispatch_deadline_at IS NOT NULL"))).toBe(
        true,
      )
      expect(constraintDefinitions.some((definition) => definition.includes("dispatch_deadline_at IS NULL"))).toBe(true)
      const indexes = yield* Effect.promise(() =>
        pool.query(`SELECT indexname FROM pg_indexes
          WHERE tablename = 'rika_hosted_executor_operations'
          ORDER BY indexname`),
      )
      expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toContain(
        "rika_hosted_executor_operations_recovery",
      )
      const definition = yield* Effect.promise(() =>
        pool.query(`SELECT pg_get_functiondef('rika_hosted_validate_executor_fence'::regproc) AS definition`),
      )
      expect(definition.rows[0]?.definition).toContain("state = 'unknown'")
      expect(definition.rows[0]?.definition).toContain("dispatched_executor_instance_id = NEW.executor_instance_id")
      expect(definition.rows[0]?.definition).toContain("clock_timestamp()")
    }),
  ),
)

it.effect.skipIf(!live)("fails closed when a dispatched operation has no reconstructable fence", () =>
  isolated(({ pool }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations.slice(0, 4)])
      yield* seedIdentity(pool)
      yield* Effect.promise(() =>
        pool.query(`INSERT INTO rika_hosted_owners (id, kind, organization_id, created_at)
          VALUES ('owner-recovery', 'organization', 'organization-recovery', now())`),
      )
      yield* Effect.promise(() =>
        pool.query(`INSERT INTO rika_hosted_projects
          (id, owner_id, name, created_by_user_id, created_at, updated_at)
          VALUES ('project-recovery', 'owner-recovery', 'Recovery', 'user-recovery', now(), now())`),
      )
      yield* Effect.promise(() =>
        pool.query(`INSERT INTO rika_hosted_workspaces
          (id, owner_id, project_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
          VALUES ('workspace-recovery', 'owner-recovery', 'project-recovery', 'user-recovery', 'local_device', false, now())`),
      )
      yield* Effect.promise(() =>
        pool.query(`INSERT INTO rika_hosted_threads
          (id, owner_id, project_id, workspace_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
          VALUES ('thread-recovery', 'owner-recovery', 'project-recovery', 'workspace-recovery', 'user-recovery', 'local_device', false, now())`),
      )
      yield* Effect.promise(() =>
        pool.query(`INSERT INTO rika_hosted_executor_assignments
          (id, owner_id, thread_id, executor_kind, placement, generation, revision, last_lease_epoch, lifecycle,
            provider_instance_id, executor_instance_id, process_incarnation, session_digest, lease_epoch, lease_expires_at)
          VALUES ('thread-recovery', 'owner-recovery', 'thread-recovery', 'local_device',
            '{"_tag":"LocalDevicePlacement","deviceId":"device-recovery"}', 2, 1, 2, 'active',
            'device-recovery', 'executor-recovery', 'process-recovery', 'session-digest', 2, now() + interval '5 minutes')`),
      )
      const failed = yield* Effect.promise(() =>
        pool
          .query(
            `INSERT INTO rika_hosted_executor_operations
          (assignment_id, owner_id, operation_key, request_digest, code, attempt, state, dispatched_generation, dispatched_lease_epoch)
          VALUES ('thread-recovery', 'owner-recovery', 'unfenced-dispatch', 'digest', 'printf 1', 0, 'dispatched', 1, 1)`,
          )
          .then(
            () => false,
            () => true,
          ),
      )
      expect(failed).toBe(true)
    }),
  ),
)

it.effect.skipIf(!live)(
  "accepts an exact old-fence recovered event and rejects the wrong generation, lease, executor, and process",
  () =>
    isolated(({ url, pool }) =>
      Effect.gen(function* () {
        yield* apply(pool, [...identityMigrations, ...migrations])
        yield* seedIdentity(pool)
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
                executorKind: "local_device",
                now: at(0),
              })
              yield* store.createThread({
                id: ids.thread,
                ownerId: ids.owner,
                projectId: ids.project,
                workspaceId: ids.workspace,
                createdByUserId: ids.user,
                executorKind: "local_device",
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
                  _tag: "LocalDevicePlacement",
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
              yield* Effect.promise(() =>
                pool.query(
                  `INSERT INTO rika_hosted_executor_operations
                (assignment_id, owner_id, operation_key, request_digest, workspace_id, session_id, thread_id,
                  turn_id, run_id, root_run_id, tool_call_id, code, attempt, state, dispatched_generation,
                  dispatched_lease_epoch, dispatched_executor_instance_id, dispatched_process_incarnation, response)
                VALUES ($1, $2, 'operation-recovered', 'digest', 'workspace-recovery', 'thread-recovery',
                  'thread-recovery', 'turn-recovery', 'run-recovery', 'run-recovery', 'call-recovery',
                  'printf recover', 0, 'unknown', $3, $4, $5, $6,
                  '{"_tag":"DomainFailure","failure":{"kind":"unknown","message":"Local operation outcome is unknown after executor disconnect"}}'::jsonb)`,
                  [
                    access.assignmentId,
                    ids.owner,
                    access.assignmentGeneration,
                    access.leaseEpoch,
                    access.executorInstanceId,
                    access.processIncarnation,
                  ],
                ),
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
