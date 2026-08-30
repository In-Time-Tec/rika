import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { identityMember, identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import { ActorAttribution } from "@rika/product/hosted-model"
import {
  rikaHostedClientAuthorities,
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjectRepositories,
  rikaHostedProjects,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolState,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as HostedPostgres from "@rika/product-store/layer"
import type { AccessWire, BindingRequest } from "@rika/remote-execution/protocol"
import { FileSystem, Config, Context, Crypto, DateTime, Effect, Layer, Random, Redacted, Schema } from "effect"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import {
  HostedToolPolicy,
  argumentsDigest,
  layer as toolPolicyLayer,
  policyFor,
} from "../../../src/hosted/execution/tool-policy"

import { authorizationAssertions } from "./tool-policy-authorization.harness"
import { auditAssertions } from "./tool-policy-audit.harness"
import { organizationAssertions } from "./tool-policy-organization.harness"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))

const personalActor = Schema.decodeSync(ActorAttribution)({
  _tag: "PersonalActor",
  owner: { _tag: "PersonalOwner", userId: "personal-user" },
  userId: "personal-user",
  clientId: "personal-client",
  deviceId: "personal-device",
})

const organizationActor = Schema.decodeSync(ActorAttribution)({
  _tag: "OrganizationActor",
  owner: { _tag: "OrganizationOwner", organizationId: "organization-1" },
  userId: "organization-user",
  membershipId: "organization-member",
  clientId: "organization-client",
  deviceId: "organization-device",
})

const access = (assignmentId: string, instanceId: string): AccessWire => ({
  version: 1,
  fence: {
    target: "orb",
    assignmentId,
    assignmentGeneration: 1,
    instanceId,
    executorId: `${assignmentId}-executor`,
    processIncarnation: `${assignmentId}-process`,
  },
  leaseEpoch: 1,
  sessionToken: `${assignmentId}-session`,
})

it.effect.skipIf(databaseUrl === "")(
  "persists secret-free exact tool decisions and enforces personal and organization audit ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = `rika_tool_policy_${Math.abs(yield* Random.nextInt)}`
        const admin = new Pool({ connectionString: databaseUrl })
        yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
        const parsed = new URL(databaseUrl)
        parsed.pathname = `/${database}`
        const url = parsed.toString()
        const pool = new Pool({ connectionString: url })
        const db = drizzle({ client: pool })
        try {
          for (const migration of [...identityMigrations, ...productMigrations])
            yield* runMigration({
              pool,
              id: migration.id,
              checksum: migration.checksum,
              sql: yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
                fileSystem.readFileString(migration.url.pathname),
              ),
            })
          const current = DateTime.nowUnsafe()
          const now = DateTime.toDate(current)
          const expiresAt = DateTime.toDate(DateTime.add(current, { minutes: 4 }))
          yield* Effect.tryPromise(() =>
            db.insert(identityUser).values([
              {
                id: "personal-user",
                name: "personal-user",
                email: "personal@example.test",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "foreign-user",
                name: "foreign-user",
                email: "foreign@example.test",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "organization-user",
                name: "organization-user",
                email: "organization@example.test",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(identityOrganization).values({
              id: "organization-1",
              name: "organization-1",
              slug: "organization-1",
              createdAt: now,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(identityMember).values({
              id: "organization-member",
              organizationId: "organization-1",
              userId: "organization-user",
              role: "member",
              createdAt: now,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedOwners).values([
              { id: "personal-owner", kind: "personal", userId: "personal-user" },
              { id: "organization-owner", kind: "organization", organizationId: "organization-1" },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedProjects).values([
              {
                id: "personal-project",
                ownerId: "personal-owner",
                name: "personal-project",
                createdByUserId: "personal-user",
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "organization-project",
                ownerId: "organization-owner",
                name: "organization-project",
                createdByUserId: "organization-user",
                createdAt: now,
                updatedAt: now,
              },
            ]),
          )
          const aggregateContext = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
          const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(aggregateContext))
          yield* aggregateDatabase.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(rikaHostedWorkspaces).values([
                {
                  id: "personal-workspace",
                  ownerId: "personal-owner",
                  projectId: "personal-project",
                  createdByUserId: "personal-user",
                  executorKind: "orb",
                  inheritProjectGrants: false,
                  createdAt: now,
                },
                {
                  id: "organization-workspace",
                  ownerId: "organization-owner",
                  projectId: "organization-project",
                  createdByUserId: "organization-user",
                  executorKind: "orb",
                  inheritProjectGrants: false,
                  createdAt: now,
                },
              ])
              yield* tx.insert(rikaWorkspaces).values([
                { ownerId: "personal-owner", path: "personal-workspace", createdAt: 1 },
                { ownerId: "organization-owner", path: "organization-workspace", createdAt: 1 },
              ])
              yield* tx.insert(rikaHostedThreads).values([
                {
                  id: "personal-thread",
                  ownerId: "personal-owner",
                  projectId: "personal-project",
                  workspaceId: "personal-workspace",
                  createdByUserId: "personal-user",
                  executorKind: "orb",
                  inheritProjectGrants: false,
                  createdAt: now,
                },
                {
                  id: "organization-thread",
                  ownerId: "organization-owner",
                  projectId: "organization-project",
                  workspaceId: "organization-workspace",
                  createdByUserId: "organization-user",
                  executorKind: "orb",
                  inheritProjectGrants: false,
                  createdAt: now,
                },
              ])
              yield* tx.insert(rikaThreads).values([
                {
                  id: "personal-thread",
                  ownerId: "personal-owner",
                  workspace: "personal-workspace",
                  title: "Personal Thread",
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  id: "organization-thread",
                  ownerId: "organization-owner",
                  workspace: "organization-workspace",
                  title: "Organization Thread",
                  createdAt: 1,
                  updatedAt: 1,
                },
              ])
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedProjectRepositories).values([
              {
                projectId: "personal-project",
                ownerId: "personal-owner",
                repositoryId: "repository-personal",
                installationId: "installation",
                installationAccountId: "account-personal",
                installationAccountLogin: "owner",
                installationAccountType: "Organization",
                repositoryOwner: "owner",
                repositoryName: "repo",
                defaultRef: "main",
                private: true,
              },
              {
                projectId: "organization-project",
                ownerId: "organization-owner",
                repositoryId: "repository-organization",
                installationId: "installation",
                installationAccountId: "account-organization",
                installationAccountLogin: "owner",
                installationAccountType: "Organization",
                repositoryOwner: "owner",
                repositoryName: "repo",
                defaultRef: "main",
                private: true,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedDevices).values([
              {
                id: "personal-device",
                userId: "personal-user",
                displayName: "personal",
                publicKeyFingerprint: "personal-key",
                createdAt: now,
                lastSeenAt: now,
              },
              {
                id: "organization-device",
                userId: "organization-user",
                displayName: "organization",
                publicKeyFingerprint: "organization-key",
                createdAt: now,
                lastSeenAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedClients).values([
              {
                id: "personal-client",
                userId: "personal-user",
                deviceId: "personal-device",
                authenticatedAt: now,
                lastSeenAt: now,
                expiresAt,
              },
              {
                id: "organization-client",
                userId: "organization-user",
                deviceId: "organization-device",
                authenticatedAt: now,
                lastSeenAt: now,
                expiresAt,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedClientAuthorities).values([
              { clientId: "personal-client", ownerId: "personal-owner", issuedAt: now, expiresAt },
              { clientId: "organization-client", ownerId: "organization-owner", issuedAt: now, expiresAt },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedExecutorAssignments).values([
              {
                id: "personal-assignment",
                ownerId: "personal-owner",
                threadId: "personal-thread",
                workspaceId: "personal-workspace",
                executorKind: "orb",
                placement: { _tag: "OrbPlacement", templateBuildId: "build", providerScope: "scope" },
                checkout: {
                  ownerId: "personal-owner",
                  projectId: "personal-project",
                  repositoryId: "repository-personal",
                  installationId: "installation",
                  owner: "owner",
                  name: "repo",
                  ref: "main",
                  commitSha: "1111111111111111111111111111111111111111",
                  private: true,
                  gitIdentity: { name: "Personal User", email: "personal@example.test" },
                },
                generation: 1,
                revision: 0,
                lastLeaseEpoch: 1,
                lifecycle: "active",
                providerInstanceId: "personal-instance",
                executorInstanceId: "personal-assignment-executor",
                processIncarnation: "personal-assignment-process",
                sessionDigest: "personal-session-digest",
                leaseEpoch: 1,
                leaseExpiresAt: expiresAt,
              },
              {
                id: "organization-assignment",
                ownerId: "organization-owner",
                threadId: "organization-thread",
                workspaceId: "organization-workspace",
                executorKind: "orb",
                placement: { _tag: "OrbPlacement", templateBuildId: "build", providerScope: "scope" },
                checkout: {
                  ownerId: "organization-owner",
                  projectId: "organization-project",
                  repositoryId: "repository-organization",
                  installationId: "installation",
                  owner: "owner",
                  name: "repo",
                  ref: "main",
                  commitSha: "2222222222222222222222222222222222222222",
                  private: true,
                  gitIdentity: { name: "Organization User", email: "organization@example.test" },
                },
                generation: 1,
                revision: 0,
                lastLeaseEpoch: 1,
                lifecycle: "active",
                providerInstanceId: "organization-instance",
                executorInstanceId: "organization-assignment-executor",
                processIncarnation: "organization-assignment-process",
                sessionDigest: "organization-session-digest",
                leaseEpoch: 1,
                leaseExpiresAt: expiresAt,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedThreadProtocolState).values([
              { ownerId: "personal-owner", threadId: "personal-thread" },
              { ownerId: "organization-owner", threadId: "organization-thread" },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedThreadProtocolCommands).values([
              {
                ownerId: "personal-owner",
                threadId: "personal-thread",
                commandId: "personal-turn",
                turnId: "personal-turn",
                idempotencyKey: "personal-command",
                expectedVersion: 0,
                threadVersion: 1,
                commitCursor: 1,
                actor: personalActor,
                command: { _tag: "SubmitPrompt" },
                state: "admitted",
                admittedAt: now,
              },
              {
                ownerId: "organization-owner",
                threadId: "organization-thread",
                commandId: "organization-turn",
                turnId: "organization-turn",
                idempotencyKey: "organization-command",
                expectedVersion: 0,
                threadVersion: 1,
                commitCursor: 1,
                actor: organizationActor,
                command: { _tag: "SubmitPrompt" },
                state: "admitted",
                admittedAt: now,
              },
            ]),
          )
          const dependencies = Layer.merge(
            HostedPostgres.layer({
              url: Redacted.make(url),
              maxConnections: 4,
            }),
            BunCrypto.layer,
          )
          const context = yield* Layer.build(
            Layer.merge(toolPolicyLayer.pipe(Layer.provide(dependencies)), dependencies),
          )
          const policy = Context.get(context, HostedToolPolicy)
          const crypto = Context.get(context, Crypto.Crypto)
          const rawMarker = "raw-secret-prompt-cell-source-marker"
          const request = {
            module: "processes",
            operation: "start",
            input: {
              command: `git push https://${rawMarker}@example.test/repository`,
            },
            sessionId: "personal-thread",
            cellId: "personal-call",
          } satisfies BindingRequest
          const admission = yield* policy.begin({
            threadId: "personal-thread",
            turnId: "personal-turn",
            workspaceId: "personal-workspace",
            operationKey: "personal-operation",
            callId: "personal-call",
            request,
            access: access("personal-assignment", "personal-instance"),
            policy: policyFor(request),
            argumentsDigest: yield* argumentsDigest(request.input).pipe(Effect.provideService(Crypto.Crypto, crypto)),
          })
          expect(admission).toMatchObject({
            actor: personalActor,
            repository: { identity: "repository-personal" },
            branch: `detached:${"1".repeat(40)}`,
            executor: { assignmentId: "personal-assignment", kind: "orb" },
            policy: { capability: "publishing.execute", approval: "exact" },
          })
          yield* policy.outcome({
            ...admission,
            authorizationId: "internal-approval",
            outcome: "suspended",
          })
          yield* authorizationAssertions.run(policy, db, personalActor, rawMarker)
          yield* policy.outcome({ ...admission, outcome: "succeeded" })
          yield* auditAssertions.run(policy, db, personalActor, rawMarker, request, admission, access)
          yield* organizationAssertions.run(policy, db, organizationActor, crypto, access)
        } finally {
          yield* Effect.tryPromise(() => pool.end())
          yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
          yield* Effect.tryPromise(() => admin.end())
        }
      }),
    ).pipe(livePlatform),
)
