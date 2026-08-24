import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Random } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/migrations"
import { runMigration } from "../../../identity/src/postgres"
import { migrations } from "../../src/hosted/migrations"

const databaseUrl = "postgresql://rika:rika@127.0.0.1:5432/rika_test"
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

it.effect.skipIf(databaseUrl === undefined)("creates fresh personal and organization owner authority", () =>
  Effect.gen(function* () {
    const database = `rika_owner_schema_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl!)
    parsed.pathname = `/${database}`
    const pool = new Pool({ connectionString: parsed.toString() })
    const rejects = (sql: string, code: string) =>
      Effect.tryPromise(() => expect(pool.query(sql)).rejects.toMatchObject({ code }))
    try {
      for (const migration of [...identityMigrations, ...migrations]) {
        const sql = yield* readFileString(migration.url)
        yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
      }
      yield* Effect.tryPromise(() =>
        pool.query(`
          INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES
            ('personal-user','Personal','personal@example.test',true,now(),now()),
            ('org-user','Org User','org@example.test',true,now(),now()),
            ('other-user','Other','other@example.test',true,now(),now());
          INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',now());
          INSERT INTO member (id,organization_id,user_id,role,created_at)
            VALUES ('org-membership','org','org-user','owner',now());
          INSERT INTO rika_hosted_owners (id,kind,user_id,organization_id) VALUES
            ('personal-owner','personal','personal-user',NULL),
            ('organization-owner','organization',NULL,'org');
          INSERT INTO rika_hosted_projects (id,owner_id,name,created_by_user_id,created_at,updated_at) VALUES
            ('personal-project','personal-owner','Personal Project','personal-user',now(),now()),
            ('org-project','organization-owner','Org Project','org-user',now(),now());
          INSERT INTO rika_hosted_workspaces (id,owner_id,project_id,created_by_user_id,executor_kind,inherit_project_grants,created_at) VALUES
            ('personal-workspace','personal-owner',NULL,'personal-user','runner',false,now()),
            ('org-workspace','organization-owner','org-project','org-user','orb',true,now());
          INSERT INTO rika_hosted_threads (id,owner_id,project_id,workspace_id,created_by_user_id,executor_kind,inherit_project_grants,created_at) VALUES
            ('personal-thread','personal-owner',NULL,'personal-workspace','personal-user','runner',false,now()),
            ('org-thread','organization-owner','org-project','org-workspace','org-user','orb',true,now());
          INSERT INTO rika_hosted_project_grants (owner_id,project_id,membership_id,role,granted_by_user_id,created_at,updated_at)
            VALUES ('organization-owner','org-project','org-membership','owner','org-user',now(),now());
          INSERT INTO rika_hosted_thread_grants (owner_id,thread_id,membership_id,role,granted_by_user_id,created_at,updated_at)
            VALUES ('organization-owner','org-thread','org-membership','owner','org-user',now(),now());
          INSERT INTO rika_hosted_credential_references (id,owner_id,project_id,provider,purpose,external_reference,metadata,created_by_user_id,created_at,updated_at)
            VALUES ('personal-credential','personal-owner',NULL,'provider','purpose','external-reference','{}','personal-user',now(),now());
          INSERT INTO rika_hosted_devices (id,user_id,display_name,public_key_fingerprint,created_at,last_seen_at) VALUES
            ('personal-device','personal-user','Personal Device','personal-fingerprint',now(),now()),
            ('org-device','org-user','Org Device','org-fingerprint',now(),now());
          INSERT INTO rika_hosted_clients (id,user_id,device_id,authenticated_at,last_seen_at,expires_at) VALUES
            ('personal-client','personal-user','personal-device',now(),now(),now()+interval '5 minutes'),
            ('org-client','org-user','org-device',now(),now(),now()+interval '5 minutes');
          INSERT INTO rika_hosted_thread_commands (owner_id,thread_id,command_id,idempotency_key,actor,sequence,commit_cursor,command,admitted_at) VALUES
            ('personal-owner','personal-thread','personal-command','personal-key',
             '{"_tag":"PersonalActor","owner":{"_tag":"PersonalOwner","userId":"personal-user"},"userId":"personal-user","clientId":"personal-client","deviceId":"personal-device"}',1,1,'{}',now()),
            ('organization-owner','org-thread','org-command','org-key',
             '{"_tag":"OrganizationActor","owner":{"_tag":"OrganizationOwner","organizationId":"org"},"userId":"org-user","membershipId":"org-membership","clientId":"org-client","deviceId":"org-device"}',1,1,'{}',now());
        `),
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
        `INSERT INTO rika_hosted_thread_commands (owner_id,thread_id,command_id,idempotency_key,actor,sequence,commit_cursor,command,admitted_at)
         VALUES ('personal-owner','personal-thread','bad-actor','bad-actor',
         '{"_tag":"OrganizationActor","owner":{"_tag":"OrganizationOwner","organizationId":"org"},"userId":"org-user","membershipId":"org-membership","clientId":"org-client","deviceId":"org-device"}',2,2,'{}',now())`,
        "23514",
      )
      yield* rejects(
        `INSERT INTO rika_hosted_project_grants (owner_id,project_id,membership_id,role,granted_by_user_id,created_at,updated_at)
         VALUES ('personal-owner','personal-project','org-membership','owner','personal-user',now(),now())`,
        "23503",
      )
      yield* Effect.tryPromise(() => pool.query(`DELETE FROM rika_hosted_owners WHERE id='personal-owner'`))
      const result = yield* Effect.tryPromise(() => pool.query(`SELECT id FROM rika_hosted_threads ORDER BY id`))
      expect(result.rows).toEqual([{ id: "org-thread" }])
    } finally {
      yield* Effect.tryPromise(() => pool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  }),
)
