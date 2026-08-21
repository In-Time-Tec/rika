import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMigrations, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { OwnerId } from "@rika/product/hosted-model"
import { ThreadId } from "@rika/product/thread-record"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { Context, Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { HostedOperations, layer as hostedOperationsLayer } from "../src/hosted-operations"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

it.effect.skipIf(databaseUrl === undefined)("admits and reads an owner-scoped PostgreSQL Thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_operations_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        yield* query(
          pool,
          `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
            VALUES
              ('owner-user', 'Owner', 'owner@example.test', true, now(), now()),
              ('other-user', 'Other', 'other@example.test', true, now(), now());
           INSERT INTO rika_hosted_owners (id, kind, user_id)
            VALUES
              ('personal-owner', 'personal', 'owner-user'),
              ('other-owner', 'personal', 'other-user')`,
        )
        const context = yield* Layer.build(
          hostedOperationsLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                PgClient.layer({ url: Redacted.make(url), maxConnections: 8 }),
                BunCrypto.layer,
                ExecutionGateway.layerTest(),
                ExecutionSessionLifecycle.layerTest(),
              ),
            ),
          ),
        )
        const operations = Context.get(context, HostedOperations)
        yield* operations.run(OwnerId.make("personal-owner"), {
          _tag: "Thread",
          action: "new",
          clientWorkspace: "workspace-1",
        })
        const rows = yield* query(pool, `SELECT id FROM rika_threads WHERE owner_id = 'personal-owner'`)
        expect(rows.rows).toHaveLength(1)
        const thread = yield* operations.thread(
          OwnerId.make("personal-owner"),
          ThreadId.make(rows.rows[0].id as string),
        )
        expect(thread).toMatchObject({ workspace: "workspace-1", title: "New thread" })
        expect(
          yield* operations.thread(OwnerId.make("other-owner"), ThreadId.make(rows.rows[0].id as string)),
        ).toBeUndefined()
      } finally {
        yield* Effect.promise(() => pool.end())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  ),
)
