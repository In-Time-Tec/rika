import { expect, it } from "@effect/vitest"
import { Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { runMigration } from "../../../identity/src/postgres"
import { identityMigrations } from "../../../identity/src/migrations"
import { migrations } from "../../src/hosted/migrations"
import * as HostedPostgres from "../../src/hosted/postgres-layer"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  IdempotencyKey,
  OrganizationId,
  OwnerId,
  ProjectId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { AssignmentRevision } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access, type Version } from "@rika/product/executor-assignments"
import { HostedStore } from "@rika/product/hosted-store"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
const at = (second: number) => Timestamp.make(`2099-01-01T00:00:${String(second).padStart(2, "0")}.000Z`)

const applyMigrations = (url: string) =>
  Effect.gen(function* () {
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...migrations]) {
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    for (const migration of [...identityMigrations, ...migrations].reverse()) {
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
    }
    return pool
  })

const ids = {
  client: ClientId.make("client-live"),
  device: DeviceId.make("device-live"),
  executor: ExecutorInstanceId.make("executor-live"),
  member: BetterAuthMemberId.make("member-live"),
  organization: OrganizationId.make("organization-live"),
  organizationOwner: OwnerId.make("organization-owner-live"),
  personalOwner: OwnerId.make("personal-owner-live"),
  personalThread: ThreadId.make("personal-thread-live"),
  personalWorkspace: WorkspaceId.make("personal-workspace-live"),
  project: ProjectId.make("project-live"),
  thread: ThreadId.make("thread-live"),
  user: BetterAuthUserId.make("user-live"),
  workspace: WorkspaceId.make("workspace-live"),
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

it.effect.skipIf(!live)("proves hosted PostgreSQL authority, rollback, concurrency, and migration idempotence", () =>
  Effect.gen(function* () {
    const database = `rika_live_${yield* Random.nextInt}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl!)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    let migrated: Pool | undefined
    try {
      migrated = yield* applyMigrations(url)
      yield* Effect.promise(() =>
        migrated!.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user-live', 'Live', 'live@example.com', true, now(), now())`),
      )
      yield* Effect.promise(() =>
        migrated!.query(`INSERT INTO "organization" (id, name, slug, created_at)
      VALUES ('organization-live', 'Live', 'live', now())`),
      )
      yield* Effect.promise(() =>
        migrated!.query(`INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES ('member-live', 'organization-live', 'user-live', 'owner', now())`),
      )
      const layer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          yield* Effect.gen(function* () {
            const store = yield* HostedStore
            const personalOwner = yield* store.putOwner({
              id: ids.personalOwner,
              identity: { _tag: "PersonalOwner", userId: ids.user },
              now: at(0),
            })
            const organizationOwner = yield* store.putOwner({
              id: ids.organizationOwner,
              identity: { _tag: "OrganizationOwner", organizationId: ids.organization },
              now: at(0),
            })
            expect(personalOwner).toMatchObject({
              id: ids.personalOwner,
              identity: { _tag: "PersonalOwner", userId: ids.user },
            })
            expect(organizationOwner).toMatchObject({
              id: ids.organizationOwner,
              identity: { _tag: "OrganizationOwner", organizationId: ids.organization },
            })
            const project = yield* store.createProject({
              id: ids.project,
              ownerId: ids.organizationOwner,
              name: "Live",
              createdByUserId: ids.user,
              now: at(0),
            })
            const personalProject = yield* store.createProject({
              id: ProjectId.make("personal-project-live"),
              ownerId: ids.personalOwner,
              name: "Live",
              createdByUserId: ids.user,
              now: at(0),
            })
            yield* store.registerDevice({
              id: ids.device,
              userId: ids.user,
              displayName: "Live",
              publicKeyFingerprint: "sha256:live",
              now: at(0),
            })
            yield* store.authenticateClient({
              id: ids.client,
              userId: ids.user,
              deviceId: ids.device,
              now: at(0),
              expiresAt: at(59),
            })
            const workspace = yield* store.createWorkspace({
              id: ids.workspace,
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              createdByUserId: ids.user,
              executorKind: "e2b",
              now: at(0),
            })
            const thread = yield* store.createThread({
              id: ids.thread,
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              workspaceId: ids.workspace,
              createdByUserId: ids.user,
              executorKind: "e2b",
              now: at(0),
            })
            const personalWorkspace = yield* store.createWorkspace({
              id: ids.personalWorkspace,
              ownerId: ids.personalOwner,
              createdByUserId: ids.user,
              executorKind: "e2b",
              now: at(0),
            })
            const personalThread = yield* store.createThread({
              id: ids.personalThread,
              ownerId: ids.personalOwner,
              workspaceId: ids.personalWorkspace,
              createdByUserId: ids.user,
              executorKind: "e2b",
              now: at(0),
            })
            expect({ project, workspace, thread }).toMatchObject({
              project: { ownerId: ids.organizationOwner },
              workspace: { ownerId: ids.organizationOwner },
              thread: { ownerId: ids.organizationOwner },
            })
            expect(personalProject).toMatchObject({ ownerId: ids.personalOwner, name: project.name })
            expect({ personalWorkspace, personalThread }).toMatchObject({
              personalWorkspace: { ownerId: ids.personalOwner },
              personalThread: { ownerId: ids.personalOwner },
            })
            expect(personalWorkspace.projectId).toBeUndefined()
            expect(personalThread.projectId).toBeUndefined()
            const rolledBack = yield* Effect.result(
              store.createProject({
                id: ProjectId.make("rollback-project"),
                ownerId: ids.organizationOwner,
                name: "Live",
                createdByUserId: ids.user,
                now: at(1),
              }),
            )
            expect(rolledBack._tag).toBe("Failure")
            expect(
              yield* store.createProject({
                id: ProjectId.make("rollback-project"),
                ownerId: ids.organizationOwner,
                name: "Rollback",
                createdByUserId: ids.user,
                now: at(1),
              }),
            ).toMatchObject({ id: "rollback-project" })
            const command = (ordinal: number, key = "same-key") => ({
              ownerId: ids.organizationOwner,
              threadId: ids.thread,
              commandId: CommandId.make(`command-${ordinal}`),
              idempotencyKey: IdempotencyKey.make(key),
              actor: {
                _tag: "OrganizationActor" as const,
                owner: { _tag: "OrganizationOwner" as const, organizationId: ids.organization },
                userId: ids.user,
                membershipId: ids.member,
                clientId: ids.client,
                deviceId: ids.device,
              },
              command: { _tag: "SubmitPrompt" as const, prompt: `prompt-${ordinal}` },
              admittedAt: at(ordinal),
            })
            const admitted = yield* Effect.all(
              [store.admitCommand(command(1, "concurrent-1")), store.admitCommand(command(2, "concurrent-2"))],
              { concurrency: 2 },
            )
            expect(new Set(admitted.map((item) => item.sequence)).size).toBe(2)
            expect(new Set(admitted.map((item) => item.commitCursor))).toEqual(new Set(["1", "2"]))
            const personalCommand = yield* store.admitCommand({
              ownerId: ids.personalOwner,
              threadId: ids.personalThread,
              commandId: CommandId.make("personal-command"),
              idempotencyKey: IdempotencyKey.make("personal-command-key"),
              actor: {
                _tag: "PersonalActor",
                owner: { _tag: "PersonalOwner", userId: ids.user },
                userId: ids.user,
                clientId: ids.client,
                deviceId: ids.device,
              },
              command: { _tag: "SubmitPrompt", prompt: "personal" },
              admittedAt: at(3),
            })
            expect(personalCommand).toMatchObject({ sequence: "1", commitCursor: "1" })
            const replayInput = command(3)
            const replay = yield* store.admitCommand(replayInput)
            expect(yield* store.admitCommand(replayInput)).toEqual(replay)
            expect(
              (yield* Effect.result(
                store.admitCommand({
                  ...replayInput,
                  command: { _tag: "SubmitPrompt", prompt: "different" },
                }),
              ))._tag,
            ).toBe("Failure")
            const assignments = yield* ExecutorAssignments
            const created = yield* assignments.create({
              id: ExecutorAssignmentId.make(ids.thread),
              ownerId: ids.organizationOwner,
              threadId: ids.thread,
              placement: { _tag: "E2BPlacement", templateBuildId: "template", providerScope: "scope" },
              checkout: null,
            })
            const provisioning = yield* assignments.beginProvisioning({
              ...version(created),
              bootstrapCredentialDigest: Redacted.make("bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            const bound = yield* assignments.bindProviderInstance({
              ...version(provisioning),
              providerInstanceId: "sandbox",
            })
            const active = yield* assignments.openSession({
              ...version(bound),
              providerInstanceId: "sandbox",
              executorInstanceId: ids.executor,
              processIncarnation: "process",
              presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
              sessionCredentialDigest: Redacted.make("session"),
              leaseLifetimeMillis: 60_000,
            })
            if (active.lifecycle._tag !== "Active")
              return yield* Effect.die(new Error("assignment did not become active"))
            const access: Access = {
              assignmentId: active.id,
              assignmentGeneration: active.generation,
              providerInstanceId: active.lifecycle.providerInstanceId,
              executorInstanceId: active.lifecycle.executorInstanceId,
              processIncarnation: active.lifecycle.processIncarnation,
              leaseEpoch: active.lifecycle.leaseEpoch,
              presentedSessionCredentialDigest: Redacted.make("session"),
            }
            const replacement = yield* assignments.beginReplacement({
              ...version(active),
              bootstrapCredentialDigest: Redacted.make("replacement"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect((yield* Effect.result(assignments.authenticate(access)))._tag).toBe("Failure")
            expect(replacement.generation).toBe("2")
            const reprovisioned = yield* assignments.bindProviderInstance({
              ...version(
                yield* assignments.beginProvisioning({
                  ...version(replacement),
                  bootstrapCredentialDigest: Redacted.make("replacement"),
                  bootstrapLifetimeMillis: 60_000,
                }),
              ),
              providerInstanceId: "sandbox-2",
            })
            const reopened = yield* assignments.openSession({
              ...version(reprovisioned),
              providerInstanceId: "sandbox-2",
              executorInstanceId: ids.executor,
              processIncarnation: "process-2",
              presentedBootstrapCredentialDigest: Redacted.make("replacement"),
              sessionCredentialDigest: Redacted.make("session-2"),
              leaseLifetimeMillis: 60_000,
            })
            if (reopened.lifecycle._tag !== "Active")
              return yield* Effect.die(new Error("replacement did not become active"))
            const replacementAccess: Access = {
              assignmentId: reopened.id,
              assignmentGeneration: reopened.generation,
              providerInstanceId: reopened.lifecycle.providerInstanceId,
              executorInstanceId: reopened.lifecycle.executorInstanceId,
              processIncarnation: reopened.lifecycle.processIncarnation,
              leaseEpoch: reopened.lifecycle.leaseEpoch,
              presentedSessionCredentialDigest: Redacted.make("session-2"),
            }
            const reconnected = yield* assignments.reconnect({ access: replacementAccess, leaseLifetimeMillis: 60_000 })
            expect((yield* Effect.result(assignments.validateFence(replacementAccess)))._tag).toBe("Failure")
            expect(reconnected.lifecycle._tag === "Active" && reconnected.lifecycle.leaseEpoch).toBe("2")
          }).pipe(Effect.provideContext(context))
        }),
      )
    } finally {
      yield* Effect.promise(() => migrated?.end() ?? Promise.resolve())
      yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.promise(() => admin.end())
    }
  }),
)
