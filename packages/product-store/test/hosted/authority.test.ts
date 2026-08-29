import { expect, it } from "@effect/vitest"

import * as BunServices from "@effect/platform-bun/BunServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import { asc, eq, sql as drizzleSql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Config, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { runMigration } from "../../../identity/src/database/postgres"
import * as schema from "../../src/database/schema/product"
import { migrations } from "../../src/hosted/migrations"

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

it.effect.skipIf(databaseUrl === "")("creates fresh personal and organization owner authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_owner_schema_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const pool = new Pool({ connectionString: parsed.toString() })
      const databaseClient = drizzle({ client: pool })
      const context = yield* Layer.build(PgClient.layer({ url: Redacted.make(parsed.toString()), maxConnections: 4 }))
      const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(context))
      const rejects = (sql: string, code: string) =>
        Effect.tryPromise(() => expect(pool.query(sql)).rejects.toMatchObject({ code }))
      try {
        for (const migration of [...identityMigrations, ...migrations]) {
          const sql = yield* readFileString(migration.url)
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const now = drizzleSql`transaction_timestamp()`
        yield* Effect.tryPromise(() =>
          databaseClient.insert(identityUser).values([
            {
              id: "personal-user",
              name: "Personal",
              email: "personal@example.test",
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "org-user",
              name: "Org User",
              email: "org@example.test",
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
          databaseClient.insert(identityOrganization).values({ id: "org", name: "Org", slug: "org", createdAt: now }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(identityMember).values({
            id: "org-membership",
            organizationId: "org",
            userId: "org-user",
            role: "owner",
            createdAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedOwners).values([
            { id: "personal-owner", kind: "personal", userId: "personal-user" },
            { id: "organization-owner", kind: "organization", organizationId: "org" },
          ]),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedProjects).values([
            {
              id: "personal-project",
              ownerId: "personal-owner",
              name: "Personal Project",
              createdByUserId: "personal-user",
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "org-project",
              ownerId: "organization-owner",
              name: "Org Project",
              createdByUserId: "org-user",
              createdAt: now,
              updatedAt: now,
            },
          ]),
        )
        yield* aggregateDatabase.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(schema.rikaHostedWorkspaces).values([
              {
                id: "personal-workspace",
                ownerId: "personal-owner",
                createdByUserId: "personal-user",
                executorKind: "runner",
                inheritProjectGrants: false,
                createdAt: now,
              },
              {
                id: "org-workspace",
                ownerId: "organization-owner",
                projectId: "org-project",
                createdByUserId: "org-user",
                executorKind: "orb",
                inheritProjectGrants: true,
                createdAt: now,
              },
            ])
            yield* tx.insert(schema.rikaWorkspaces).values([
              { ownerId: "personal-owner", path: "personal-workspace", createdAt: 1 },
              { ownerId: "organization-owner", path: "org-workspace", createdAt: 1 },
            ])
            yield* tx.insert(schema.rikaHostedThreads).values([
              {
                id: "personal-thread",
                ownerId: "personal-owner",
                workspaceId: "personal-workspace",
                createdByUserId: "personal-user",
                executorKind: "runner",
                inheritProjectGrants: false,
                createdAt: now,
              },
              {
                id: "org-thread",
                ownerId: "organization-owner",
                projectId: "org-project",
                workspaceId: "org-workspace",
                createdByUserId: "org-user",
                executorKind: "orb",
                inheritProjectGrants: true,
                createdAt: now,
              },
            ])
            yield* tx.insert(schema.rikaThreads).values([
              {
                id: "personal-thread",
                ownerId: "personal-owner",
                workspace: "personal-workspace",
                title: "Personal",
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: "org-thread",
                ownerId: "organization-owner",
                workspace: "org-workspace",
                title: "Organization",
                createdAt: 1,
                updatedAt: 1,
              },
            ])
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedProjectGrants).values({
            ownerId: "organization-owner",
            projectId: "org-project",
            membershipId: "org-membership",
            role: "owner",
            grantedByUserId: "org-user",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedThreadGrants).values({
            ownerId: "organization-owner",
            threadId: "org-thread",
            membershipId: "org-membership",
            role: "owner",
            grantedByUserId: "org-user",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedCredentialReferences).values({
            id: "personal-credential",
            ownerId: "personal-owner",
            provider: "provider",
            purpose: "purpose",
            externalReference: "external-reference",
            metadata: {},
            createdByUserId: "personal-user",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedDevices).values([
            {
              id: "personal-device",
              userId: "personal-user",
              displayName: "Personal Device",
              publicKeyFingerprint: "personal-fingerprint",
              createdAt: now,
              lastSeenAt: now,
            },
            {
              id: "org-device",
              userId: "org-user",
              displayName: "Org Device",
              publicKeyFingerprint: "org-fingerprint",
              createdAt: now,
              lastSeenAt: now,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedClients).values([
            {
              id: "personal-client",
              userId: "personal-user",
              deviceId: "personal-device",
              authenticatedAt: now,
              lastSeenAt: now,
              expiresAt: drizzleSql`transaction_timestamp() + interval '5 minutes'`,
            },
            {
              id: "org-client",
              userId: "org-user",
              deviceId: "org-device",
              authenticatedAt: now,
              lastSeenAt: now,
              expiresAt: drizzleSql`transaction_timestamp() + interval '5 minutes'`,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedThreadProtocolState).values([
            { ownerId: "personal-owner", threadId: "personal-thread", version: 1 },
            { ownerId: "organization-owner", threadId: "org-thread", version: 1 },
          ]),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedThreadProtocolCommands).values([
            {
              ownerId: "personal-owner",
              threadId: "personal-thread",
              commandId: "personal-command",
              idempotencyKey: "personal-key",
              actor: {
                _tag: "PersonalActor",
                owner: { _tag: "PersonalOwner", userId: "personal-user" },
                userId: "personal-user",
                clientId: "personal-client",
                deviceId: "personal-device",
              },
              expectedVersion: 0,
              threadVersion: 1,
              commitCursor: 1,
              command: {},
              state: "admitted",
              admittedAt: now,
            },
            {
              ownerId: "organization-owner",
              threadId: "org-thread",
              commandId: "org-command",
              idempotencyKey: "org-key",
              actor: {
                _tag: "OrganizationActor",
                owner: { _tag: "OrganizationOwner", organizationId: "org" },
                userId: "org-user",
                membershipId: "org-membership",
                clientId: "org-client",
                deviceId: "org-device",
              },
              expectedVersion: 0,
              threadVersion: 1,
              commitCursor: 1,
              command: {},
              state: "admitted",
              admittedAt: now,
            },
          ]),
        )
        yield* rejects(
          `INSERT INTO rika_hosted_owners (id,kind,user_id,organization_id) VALUES ('bad','personal','other-user','org')`,
          "23514",
        )
        yield* rejects(
          `INSERT INTO rika_hosted_threads (id,owner_id,workspace_id,created_by_user_id,executor_kind,inherit_project_grants,created_at)
         VALUES ('cross-owner','organization-owner','personal-workspace','org-user','runner',false,now())`,
          "23503",
        )
        yield* rejects(
          `INSERT INTO rika_hosted_threads (id,owner_id,project_id,workspace_id,created_by_user_id,executor_kind,inherit_project_grants,created_at)
         VALUES ('wrong-null-project','personal-owner','personal-project','personal-workspace','personal-user','runner',false,now())`,
          "23503",
        )
        yield* rejects(
          `INSERT INTO rika_hosted_thread_protocol_commands (owner_id,thread_id,command_id,idempotency_key,actor,expected_version,thread_version,commit_cursor,command,state,admitted_at)
         VALUES ('personal-owner','personal-thread','bad-actor','bad-actor',
         '{"_tag":"OrganizationActor","owner":{"_tag":"OrganizationOwner","organizationId":"org"},"userId":"org-user","membershipId":"org-membership","clientId":"org-client","deviceId":"org-device"}',1,2,2,'{}','admitted',now())`,
          "23514",
        )
        yield* rejects(
          `INSERT INTO rika_hosted_project_grants (owner_id,project_id,membership_id,role,granted_by_user_id,created_at,updated_at)
         VALUES ('personal-owner','personal-project','org-membership','owner','personal-user',now(),now())`,
          "23503",
        )
        yield* Effect.tryPromise(() =>
          databaseClient.delete(schema.rikaHostedOwners).where(eq(schema.rikaHostedOwners.id, "personal-owner")),
        )
        const result = yield* Effect.tryPromise(() =>
          databaseClient
            .select({ id: schema.rikaHostedThreads.id })
            .from(schema.rikaHostedThreads)
            .orderBy(asc(schema.rikaHostedThreads.id)),
        )
        expect(result).toEqual([{ id: "org-thread" }])
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ),
)
