import { expect, it } from "@effect/vitest"

import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Inspectable, Layer, Logger, Random, Redacted } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { eq, sql as drizzleSql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import * as schema from "../../src/database/schema/product"
import { runMigration } from "../../../identity/src/database/postgres"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { migrations } from "../../src/hosted/migrations"
import * as HostedPostgres from "../../src/hosted/layer"
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
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import { TurnId } from "@rika/product/turn-record"
import { AssignmentRevision, type WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access, type Version } from "@rika/product/executor-assignments"
import { HostedStore } from "@rika/product/hosted-store"
import {
  HostedExecutionOperations,
  layer as hostedExecutionOperationsLayer,
} from "../../src/hosted/execution/operations"
import { EnvironmentStore } from "@rika/product/environment-store"
import { EnvironmentReferenceId, SourceCommitSha, resolveEnvironmentReferences } from "@rika/product/environment-policy"

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

const applyMigrations = (url: string) =>
  Effect.gen(function* () {
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...migrations]) {
      const sql = yield* readFileString(migration.url)
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    for (const migration of [...identityMigrations, ...migrations].reverse()) {
      const sql = yield* readFileString(migration.url)
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
    }
    return pool
  })

const ids = {
  client: ClientId.make("client-live"),
  device: DeviceId.make("device-live"),
  assignment: ExecutorAssignmentId.make("assignment-live"),
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

const capabilities = (digestCharacter: string): WorkspaceCapabilitySnapshot => ({
  environmentDigest: `sha256:${digestCharacter.repeat(64)}`,
  capturedAt: at(0),
  filesystem: { _tag: "Ready", detail: "workspace filesystem" },
  typescriptKernel: { _tag: "Ready", detail: "TypeScript kernel" },
  git: { _tag: "Ready", detail: "git" },
  process: { _tag: "Ready", detail: "process execution" },
  pty: { _tag: "Ready", detail: "PTY" },
  browser: { _tag: "Unavailable", reason: "browser not installed" },
  services: { _tag: "Ready", detail: "repository services" },
  workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle" },
})

it.effect.skipIf(!live)("proves hosted PostgreSQL authority, rollback, concurrency, and migration idempotence", () => {
  const observations: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.map(Logger.formatStructured, (record) => observations.push(record))
  return Effect.gen(function* () {
    const database = `rika_live_${yield* Random.nextInt}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    let migrated: Pool | undefined
    try {
      migrated = yield* applyMigrations(url)
      const db = drizzle({ client: migrated })
      const now = drizzleSql`now()`
      yield* Effect.tryPromise(() =>
        db.insert(identityUser).values({
          id: "user-live",
          name: "Live",
          email: "live@example.com",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(identityOrganization).values({ id: "organization-live", name: "Live", slug: "live", createdAt: now }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(identityMember).values({
          id: "member-live",
          organizationId: "organization-live",
          userId: "user-live",
          role: "owner",
          createdAt: now,
        }),
      )
      const hosted = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
      const layer = Layer.merge(hosted, hostedExecutionOperationsLayer.pipe(Layer.provide(hosted)))
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
            const environments = yield* EnvironmentStore
            const encrypted = (seed: number) => ({
              keyVersion: 1 as const,
              nonce: new Uint8Array(12).fill(seed),
              ciphertext: new Uint8Array([seed, seed + 1]),
              authenticationTag: new Uint8Array(16).fill(seed + 2),
            })
            const valueInput = {
              id: EnvironmentReferenceId.make("environment-live"),
              ownerId: ids.organizationOwner,
              scope: "organization" as const,
              scopeId: ids.organizationOwner,
              name: "LIVE_SECRET",
              classification: "secret" as const,
              phases: ["setup", "runtime"] as const,
              valueDigest: `sha256:${"a".repeat(64)}` as const,
              encrypted: encrypted(1),
              userId: ids.user,
              actorUserId: ids.user,
            }
            expect(yield* environments.putValue(valueInput)).toMatchObject({ revision: "1", state: "active" })
            expect(
              yield* environments.putValue({
                ...valueInput,
                valueDigest: `sha256:${"b".repeat(64)}`,
                encrypted: encrypted(4),
              }),
            ).toMatchObject({ revision: "2", valueDigest: `sha256:${"b".repeat(64)}` })
            const rotations = yield* Effect.all(
              [
                environments.putValue({
                  ...valueInput,
                  valueDigest: `sha256:${"c".repeat(64)}`,
                  encrypted: encrypted(7),
                }),
                environments.putValue({
                  ...valueInput,
                  valueDigest: `sha256:${"d".repeat(64)}`,
                  encrypted: encrypted(10),
                }),
              ],
              { concurrency: 2 },
            )
            expect(rotations.map(({ revision }) => revision).sort()).toEqual(["3", "4"])
            const untrusted = {
              owner: "In-Time-Tec",
              commitSha: SourceCommitSha.make("c".repeat(40)),
              fork: true,
              trustedRef: false,
            }
            const beforeApproval = yield* environments.resolvePhase({
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              userId: ids.user,
              phase: "setup",
              source: untrusted,
            })
            expect(beforeApproval.egress).toEqual({ phase: "setup", allow: [] })
            expect(
              resolveEnvironmentReferences({
                ...beforeApproval,
                phase: "setup",
                source: untrusted,
              }),
            ).toEqual([])
            yield* environments.putApproval({
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              sourceOwner: untrusted.owner,
              sourceCommitSha: untrusted.commitSha,
              phase: "setup",
              actorUserId: ids.user,
            })
            const approved = yield* environments.resolvePhase({
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              userId: ids.user,
              phase: "setup",
              source: untrusted,
            })
            expect(approved.organizationPersonalOverrides).toBe(true)
            yield* environments.putOrganizationPolicy({
              ownerId: ids.organizationOwner,
              personalOverrides: false,
              actorUserId: ids.user,
            })
            expect(
              (yield* environments.resolvePhase({
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                userId: ids.user,
                phase: "setup",
                source: untrusted,
              })).organizationPersonalOverrides,
            ).toBe(false)
            expect(
              resolveEnvironmentReferences({ ...approved, phase: "setup", source: untrusted }).map(
                (reference) => reference.name,
              ),
            ).toEqual(["LIVE_SECRET"])
            yield* environments.putEgress({
              ownerId: ids.organizationOwner,
              policy: { phase: "setup", allow: ["registry.npmjs.org"] },
              actorUserId: ids.user,
            })
            expect(
              (yield* environments.resolvePhase({
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                userId: ids.user,
                phase: "setup",
                source: untrusted,
              })).egress,
            ).toEqual({ phase: "setup", allow: ["registry.npmjs.org"] })
            yield* environments.putEgress({
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              policy: { phase: "setup", allow: ["github.com"] },
              actorUserId: ids.user,
            })
            expect(
              (yield* environments.resolvePhase({
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                userId: ids.user,
                phase: "setup",
                source: untrusted,
              })).egress,
            ).toEqual({ phase: "setup", allow: ["github.com"] })
            expect(
              (yield* environments.resolvePhase({
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                userId: ids.user,
                phase: "runtime",
                source: untrusted,
              })).egress,
            ).toEqual({ phase: "runtime", allow: [] })
            const changedSource = { ...untrusted, commitSha: SourceCommitSha.make("d".repeat(40)) }
            const changed = yield* environments.resolvePhase({
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              userId: ids.user,
              phase: "setup",
              source: changedSource,
            })
            expect(resolveEnvironmentReferences({ ...changed, phase: "setup", source: changedSource })).toEqual([])
            expect(
              yield* environments.revokeApproval({
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                sourceOwner: untrusted.owner,
                sourceCommitSha: untrusted.commitSha,
                phase: "setup",
                actorUserId: ids.user,
              }),
            ).toMatchObject({ revokedAt: expect.any(String) })
            const revokedApproval = yield* environments.resolvePhase({
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              userId: ids.user,
              phase: "setup",
              source: untrusted,
            })
            expect(resolveEnvironmentReferences({ ...revokedApproval, phase: "setup", source: untrusted })).toEqual([])
            expect(
              yield* environments.revokeValue({
                ownerId: ids.organizationOwner,
                userId: ids.user,
                scope: "organization",
                scopeId: ids.organizationOwner,
                name: "LIVE_SECRET",
                actorUserId: ids.user,
              }),
            ).toMatchObject({ revision: "5", state: "revoked" })
            expect(
              (yield* environments.resolvePhase({
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                userId: ids.user,
                phase: "setup",
                source: untrusted,
              })).candidates,
            ).toEqual([])
            const revokedMaterial = yield* Effect.tryPromise(() =>
              db
                .select({
                  keyVersion: schema.rikaHostedEnvironmentValues.keyVersion,
                  nonce: schema.rikaHostedEnvironmentValues.nonce,
                  ciphertext: schema.rikaHostedEnvironmentValues.ciphertext,
                  authenticationTag: schema.rikaHostedEnvironmentValues.authenticationTag,
                })
                .from(schema.rikaHostedEnvironmentValues)
                .where(eq(schema.rikaHostedEnvironmentValues.id, "environment-live")),
            )
            expect(revokedMaterial).toEqual([
              { keyVersion: null, nonce: null, ciphertext: null, authenticationTag: null },
            ])
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
            yield* store.grantClientAuthority({
              ownerId: ids.organizationOwner,
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
            yield* store.grantClientAuthority({
              ownerId: ids.personalOwner,
              actor: {
                _tag: "PersonalActor",
                owner: { _tag: "PersonalOwner", userId: ids.user },
                userId: ids.user,
                clientId: ids.client,
                deviceId: ids.device,
              },
              now: at(0),
              expiresAt: at(59),
            })
            const workspace = yield* store.createWorkspace({
              id: ids.workspace,
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              createdByUserId: ids.user,
              executorKind: "orb",
              now: at(0),
            })
            const thread = yield* store.createThread({
              id: ids.thread,
              ownerId: ids.organizationOwner,
              projectId: ids.project,
              workspaceId: ids.workspace,
              createdByUserId: ids.user,
              executorKind: "orb",
              now: at(0),
            })
            const personalWorkspace = yield* store.createWorkspace({
              id: ids.personalWorkspace,
              ownerId: ids.personalOwner,
              createdByUserId: ids.user,
              executorKind: "orb",
              now: at(0),
            })
            const personalThread = yield* store.createThread({
              id: ids.personalThread,
              ownerId: ids.personalOwner,
              workspaceId: ids.personalWorkspace,
              createdByUserId: ids.user,
              executorKind: "orb",
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
            expect(yield* store.readThread({ ownerId: ids.organizationOwner, threadId: ids.thread })).toEqual(thread)
            expect(yield* store.readThread({ ownerId: ids.personalOwner, threadId: ids.thread })).toBeUndefined()
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
            yield* Effect.tryPromise(() =>
              db
                .insert(schema.rikaWorkspaces)
                .values({ ownerId: ids.organizationOwner, path: "workspace-live", createdAt: 1 }),
            )
            yield* Effect.tryPromise(() =>
              db.insert(schema.rikaThreads).values({
                id: ids.thread,
                ownerId: ids.organizationOwner,
                workspace: "workspace-live",
                title: "Live",
                createdAt: 1,
                updatedAt: 1,
              }),
            )
            const promptInput = {
              ...command(4, "observability-admission-key"),
              turnId: TurnId.make("observability-turn-live"),
              prompt: "private-observability-prompt",
              executionRoute: ExecutionRoute.testExecutionRoute(),
              queueCapacity: 8,
              readinessProof: true,
            }
            const promptAdmission = yield* store.admitPrompt(promptInput)
            expect(yield* store.admitPrompt({ ...promptInput, readinessProof: false })).toEqual(promptAdmission)
            const durableAdmission = yield* Effect.tryPromise(() =>
              db
                .select({ threadId: schema.rikaTurns.threadId, id: schema.rikaTurns.id })
                .from(schema.rikaTurns)
                .where(eq(schema.rikaTurns.id, "observability-turn-live")),
            )
            expect(durableAdmission).toEqual([{ threadId: "thread-live", id: "observability-turn-live" }])
            const admissionLogs = observations.filter((record) =>
              Inspectable.toStringUnknown(record).includes("hosted.admission.success"),
            )
            expect(admissionLogs).toHaveLength(1)
            const renderedAdmission = Inspectable.toStringUnknown(admissionLogs)
            expect(renderedAdmission).toContain("thread-live")
            expect(renderedAdmission).toContain("observability-turn-live")
            for (const secret of ["organization-owner-live", "command-4", "private-observability-prompt"])
              expect(renderedAdmission).not.toContain(secret)
            yield* Effect.tryPromise(() =>
              db
                .insert(schema.rikaHostedGitIdentities)
                .values({ ownerId: ids.organizationOwner, name: "Rika Live", email: "rika-live@example.test" }),
            )
            yield* Effect.tryPromise(() =>
              db.insert(schema.rikaHostedProjectRepositories).values({
                projectId: ids.project,
                ownerId: ids.organizationOwner,
                repositoryId: "repository-live",
                installationId: "installation-live",
                installationAccountId: "account-live",
                installationAccountLogin: "In-Time-Tec",
                installationAccountType: "Organization",
                repositoryOwner: "In-Time-Tec",
                repositoryName: "rika",
                defaultRef: "main",
                private: true,
              }),
            )
            const assignments = yield* ExecutorAssignments
            const created = yield* assignments.create({
              id: ids.assignment,
              ownerId: ids.organizationOwner,
              threadId: ids.thread,
              workspaceId: ids.workspace,
              placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
              checkout: {
                ownerId: ids.organizationOwner,
                projectId: ids.project,
                repositoryId: "repository-live",
                installationId: "installation-live",
                owner: "In-Time-Tec",
                name: "rika",
                ref: "main",
                commitSha: "a".repeat(40),
                private: true,
                gitIdentity: { name: "Rika Live", email: "rika-live@example.test" },
              },
            })
            expect(created.id).not.toBe(created.threadId)
            expect(yield* assignments.getForThread(ids.thread)).toEqual(created)
            const provisioning = yield* assignments.beginProvisioning({
              ...version(created),
              bootstrapCredentialDigest: Redacted.make("bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect(
              yield* assignments.isBootstrapLive({
                assignmentId: provisioning.id,
                generation: provisioning.generation,
              }),
            ).toBe(true)
            yield* Effect.tryPromise(() =>
              db
                .update(schema.rikaHostedExecutorAssignments)
                .set({ bootstrapExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, ids.assignment)),
            )
            expect(
              yield* assignments.isBootstrapLive({
                assignmentId: provisioning.id,
                generation: provisioning.generation,
              }),
            ).toBe(false)
            yield* Effect.tryPromise(() =>
              db
                .update(schema.rikaHostedExecutorAssignments)
                .set({ bootstrapExpiresAt: drizzleSql`clock_timestamp() + interval '1 minute'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, ids.assignment)),
            )
            const bound = yield* assignments.bindProviderInstance({
              ...version(provisioning),
              providerInstanceId: "sandbox",
            })
            const active = yield* assignments.openSession({
              ...version(bound),
              providerInstanceId: "sandbox",
              executorInstanceId: ids.executor,
              processIncarnation: "process",
              capabilities: capabilities("a"),
              presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
              sessionCredentialDigest: Redacted.make("session"),
              leaseLifetimeMillis: 60_000,
            })
            if (active.lifecycle._tag !== "Active")
              return yield* Effect.die(new Error("assignment did not become active"))
            expect(active.capabilityGeneration).toBe(active.generation)
            expect(active.capabilities?.environmentDigest).toBe(`sha256:${"a".repeat(64)}`)
            const operations = yield* HostedExecutionOperations
            const operation = {
              assignmentId: String(active.id),
              operationKey: "operation-orb-live",
              requestDigest: "request-orb-live",
              workspaceId: String(active.workspaceId),
              sessionId: "session-orb-live",
              threadId: String(active.threadId),
              turnId: "turn-orb-live",
              runId: "run-orb-live",
              rootRunId: "run-orb-live",
              toolCallId: "tool-orb-live",
              code: "1 + 1",
              attempt: 0,
              replayPolicy: "pure" as const,
              admittedAt: null,
              deadlineAt: at(59),
            }
            expect(
              yield* operations.admitWorkspaceCapabilities({
                threadId: operation.threadId,
                turnId: operation.turnId,
                assignmentId: operation.assignmentId,
                workspaceId: operation.workspaceId,
                assignmentGeneration: Number(active.generation),
                environmentDigest: capabilities("a").environmentDigest,
                requiredCapabilities: [],
              }),
            ).toBe(true)
            expect(yield* operations.upsertOperation(operation)).toMatchObject({ state: "accepted" })
            expect(
              yield* operations.claimDispatch(operation, {
                assignmentGeneration: Number(active.generation),
                leaseEpoch: Number(active.lifecycle.leaseEpoch),
                providerInstanceId: active.lifecycle.providerInstanceId,
                executorInstanceId: active.lifecycle.executorInstanceId,
                processIncarnation: active.lifecycle.processIncarnation,
              }),
            ).toBe("claimed")
            const access: Access = {
              assignmentId: active.id,
              assignmentGeneration: active.generation,
              providerInstanceId: active.lifecycle.providerInstanceId,
              executorInstanceId: active.lifecycle.executorInstanceId,
              processIncarnation: active.lifecycle.processIncarnation,
              leaseEpoch: active.lifecycle.leaseEpoch,
              presentedSessionCredentialDigest: Redacted.make("session"),
            }
            const refreshedCapabilities = capabilities("c")
            const updated = yield* assignments.updateCapabilities({ access, capabilities: refreshedCapabilities })
            expect(updated.capabilityGeneration).toBe(updated.generation)
            expect(updated.capabilities).toEqual(refreshedCapabilities)
            expect(
              yield* Effect.result(
                assignments.beginReplacement({
                  ...version(updated),
                  placement: {
                    _tag: "OrbPlacement",
                    templateBuildId: "template-v2",
                    providerScope: "another-scope",
                  },
                  bootstrapCredentialDigest: Redacted.make("invalid-replacement"),
                  bootstrapLifetimeMillis: 60_000,
                }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
            const replacement = yield* assignments.beginReplacement({
              ...version(updated),
              placement: { _tag: "OrbPlacement", templateBuildId: "template-v2", providerScope: "scope" },
              bootstrapCredentialDigest: Redacted.make("replacement"),
              bootstrapLifetimeMillis: 60_000,
            })
            expect((yield* Effect.result(assignments.authenticate(access)))._tag).toBe("Failure")
            expect(replacement.generation).toBe("2")
            expect(replacement.placement).toEqual({
              _tag: "OrbPlacement",
              templateBuildId: "template-v2",
              providerScope: "scope",
            })
            expect(replacement).toMatchObject({ capabilityGeneration: null, capabilities: null })
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
              capabilities: capabilities("b"),
              presentedBootstrapCredentialDigest: Redacted.make("replacement"),
              sessionCredentialDigest: Redacted.make("session-2"),
              leaseLifetimeMillis: 60_000,
            })
            if (reopened.lifecycle._tag !== "Active")
              return yield* Effect.die(new Error("replacement did not become active"))
            expect(reopened.capabilityGeneration).toBe(reopened.generation)
            expect(reopened.capabilities?.environmentDigest).toBe(`sha256:${"b".repeat(64)}`)
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
            const orphan = yield* assignments.create({
              id: ExecutorAssignmentId.make("assignment-orphan-live"),
              ownerId: ids.personalOwner,
              threadId: ids.personalThread,
              workspaceId: ids.personalWorkspace,
              placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
              checkout: null,
            })
            const orphanProvisioning = yield* assignments.beginProvisioning({
              ...version(orphan),
              bootstrapCredentialDigest: Redacted.make("orphan-bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            })
            const orphanIdentity = {
              providerInstanceId: "sandbox-orphan-live",
              assignmentId: orphanProvisioning.id,
              generation: orphanProvisioning.generation,
            }
            expect(yield* assignments.claimOrphan({ providerInstanceId: "sandbox-unbound-live" })).toBe("preserved")
            expect(
              yield* assignments.claimOrphan({
                providerInstanceId: "sandbox-unknown-live",
                assignmentId: ExecutorAssignmentId.make("assignment-unknown-live"),
                generation: orphanProvisioning.generation,
              }),
            ).toBe("preserved")
            expect(yield* assignments.claimOrphan(orphanIdentity)).toBe("preserved")
            yield* Effect.tryPromise(() =>
              db
                .update(schema.rikaHostedExecutorAssignments)
                .set({ bootstrapExpiresAt: drizzleSql`clock_timestamp() - interval '1 second'` })
                .where(eq(schema.rikaHostedExecutorAssignments.id, orphan.id)),
            )
            expect(yield* assignments.claimOrphan(orphanIdentity)).toBe("claimed")
            expect(yield* assignments.get(orphan.id)).toMatchObject({
              generation: "2",
              lifecycle: { _tag: "Pending" },
            })
            expect(
              (yield* Effect.result(
                assignments.bindProviderInstance({
                  ...version(orphanProvisioning),
                  providerInstanceId: "sandbox-orphan-live",
                }),
              ))._tag,
            ).toBe("Failure")
          }).pipe(Effect.provideContext(context))
        }),
      )
    } finally {
      if (migrated !== undefined) {
        const migratedPool = migrated
        yield* Effect.tryPromise(() => migratedPool.end())
      }
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
})
