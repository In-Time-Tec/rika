import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMigrations, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { ServerFrame } from "@rika/product/client-protocol"
import { OwnerId } from "@rika/product/hosted-model"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId } from "@rika/product/thread-record"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { Context, Effect, Layer, Random, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { testLayer as hostedModelRegistryTestLayer } from "../src/hosted-model-registry"
import { HostedThreadApplication, layer as hostedThreadApplicationLayer } from "../src/hosted-thread-application"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

it.effect.skipIf(databaseUrl === undefined)("encodes an owner-scoped snapshot without initialization writes", () =>
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
        const dependencies = Layer.mergeAll(
          PgClient.layer({ url: Redacted.make(url), maxConnections: 8 }),
          BunCrypto.layer,
          ExecutionGateway.layerTest(),
          ExecutionSessionLifecycle.layerTest(),
          hostedModelRegistryTestLayer,
          Layer.succeed(ThreadProtocolStore, {
            initializeThread: () => Effect.die("unused"),
            admitCommand: () => Effect.die("unused"),
            completeCommand: () => Effect.die("unused"),
            appendEvents: () => Effect.die("unused"),
            replay: () => Effect.die("unused"),
            acknowledgeCursor: () => Effect.die("unused"),
            issueTicket: () => Effect.die("unused"),
            redeemTicket: () => Effect.die("unused"),
            revokeTicket: () => Effect.die("unused"),
          }),
        )
        const context = yield* Layer.build(hostedThreadApplicationLayer.pipe(Layer.provideMerge(dependencies)))
        const application = Context.get(context, HostedThreadApplication)
        yield* query(
          pool,
          `INSERT INTO rika_workspaces (owner_id, path, created_at)
            VALUES ('personal-owner', 'workspace-1', 1);
           INSERT INTO rika_threads (id, owner_id, workspace, title, created_at, updated_at)
            VALUES ('owner-thread', 'personal-owner', 'workspace-1', 'New thread', 1, 1)`,
        )
        const threadId = ThreadId.make("owner-thread")
        const thread = yield* application.thread(OwnerId.make("personal-owner"), threadId)
        expect(thread).toMatchObject({ workspace: "workspace-1", title: "New thread" })
        expect(yield* application.thread(OwnerId.make("other-owner"), threadId)).toBeUndefined()
        yield* query(
          pool,
          `INSERT INTO rika_workspaces (owner_id, path, created_at)
            VALUES ('other-owner', 'read-only-workspace', 1);
           INSERT INTO rika_threads (id, owner_id, workspace, title, created_at, updated_at)
            VALUES ('read-only-thread', 'other-owner', 'read-only-workspace', 'Read only', 1, 1)`,
        )
        const sql = Context.get(context, PgClient.PgClient)
        const snapshot = yield* sql.withTransaction(
          sql`SET TRANSACTION READ ONLY`.pipe(
            Effect.andThen(application.snapshot(OwnerId.make("other-owner"), ThreadId.make("read-only-thread"))),
          ),
        )
        expect(snapshot).toMatchObject({
          thread: { id: "read-only-thread" },
          turns: [],
          units: [],
          queue: { revision: 0, turns: [] },
          pendingAuthorizations: [],
        })
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ServerFrame))({
          protocolVersion: 1,
          payload: {
            _tag: "ThreadSnapshot",
            threadId: "read-only-thread" as never,
            threadVersion: "0" as never,
            cursor: "0" as never,
            snapshot,
          },
        })
        expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerFrame))(encoded)).toMatchObject({
          payload: { _tag: "ThreadSnapshot", snapshot },
        })
      } finally {
        yield* Effect.promise(() => pool.end())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  ),
)
