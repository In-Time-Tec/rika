/* oxlint-disable effecttsgo/async-function -- this fixture drives the foreign PostgreSQL and Fetch boundaries. */
/* oxlint-disable effecttsgo/global-date-in-effect -- fixture timestamps are created at the test boundary. */
/* oxlint-disable effecttsgo/node-builtin-import -- this fixture resolves migration files from URLs. */
/* oxlint-disable effecttsgo/prefer-path -- migration files are resolved from their URL boundary. */
/* oxlint-disable effecttsgo/prefer-schema-over-json -- test request bodies are not used by these GET routes. */
/* oxlint-disable anti-slop/no-unknown-parameters -- the database fixture narrows rows at the assertions. */
import { Config, Context, DateTime, Effect, Layer, Option, Random, Redacted, Schema } from "effect"
import * as PgClient from "@effect/sql-pg/PgClient"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import type { IdentityRuntime } from "@rika/identity"
import { identityMigrations, identityUser, runMigration } from "@rika/identity"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import { ProductRepository, layer as productRepositoryLayer } from "@rika/product-store/product-repository"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as schema from "@rika/product-store/database-schema"
import { makeRepositoryProductAuthority } from "../src/hosted/product-authority"
import { handleApiV2Request } from "../src/hosted/http"
import { ThreadPage } from "../src/hosted/product-routes"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const now = DateTime.toDate(DateTime.makeUnsafe(1_757_376_000_000))
const unused = () => Effect.die("unused repository route fixture seam")
const responseJson = (response: Response) => Effect.tryPromise(() => response.json())

const identity: IdentityRuntime = {
  handle: () => Effect.succeed(new Response("unused")),
  identify: () => Effect.succeed({ userId: "user", clientId: "client" }),
  browserSession: () => Effect.succeed(Option.none<never>()).pipe(Effect.map(Option.getOrUndefined)),
  protectedResourceMetadata: Effect.succeed({}),
}

it.effect.skipIf(databaseUrl === "")("serves owner-authorized product metadata from PostgreSQL with stable cursors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_api_v2_routes_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const databaseClient = drizzle({ client: pool })
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.tryPromise(() => Bun.file(fileURLToPath(migration.url)).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        yield* Effect.tryPromise(() =>
          databaseClient.insert(identityUser).values({
            id: "user",
            name: "Route User",
            email: "route-user@example.test",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedOwners).values({ id: "owner", kind: "personal", userId: "user" }),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaHostedWorkspaces).values([
            {
              id: "workspace-a",
              ownerId: "owner",
              createdByUserId: "user",
              executorKind: "runner",
              inheritProjectGrants: false,
              createdAt: now,
            },
            {
              id: "workspace-private",
              ownerId: "owner",
              createdByUserId: "user",
              executorKind: "runner",
              inheritProjectGrants: false,
              createdAt: now,
            },
            {
              id: "workspace-b",
              ownerId: "owner",
              createdByUserId: "user",
              executorKind: "runner",
              inheritProjectGrants: false,
              createdAt: now,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.insert(schema.rikaWorkspaces).values([
            { ownerId: "owner", path: "workspace-a", createdAt: 300 },
            { ownerId: "owner", path: "workspace-private", createdAt: 200 },
            { ownerId: "owner", path: "workspace-b", createdAt: 100 },
          ]),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.transaction(async (tx) => {
            await tx.insert(schema.rikaThreads).values([
              {
                id: "thread-a",
                ownerId: "owner",
                workspace: "workspace-a",
                title: "Visible A",
                createdAt: 300,
                updatedAt: 300,
              },
              {
                id: "thread-private",
                ownerId: "owner",
                workspace: "workspace-private",
                title: "Private",
                createdAt: 200,
                updatedAt: 200,
              },
              {
                id: "thread-b",
                ownerId: "owner",
                workspace: "workspace-b",
                title: "Visible B",
                createdAt: 100,
                updatedAt: 100,
              },
            ])
            await tx.insert(schema.rikaHostedThreads).values([
              {
                id: "thread-a",
                ownerId: "owner",
                workspaceId: "workspace-a",
                createdByUserId: "user",
                executorKind: "runner",
                inheritProjectGrants: false,
                createdAt: now,
              },
              {
                id: "thread-private",
                ownerId: "owner",
                workspaceId: "workspace-private",
                createdByUserId: "user",
                executorKind: "runner",
                inheritProjectGrants: false,
                createdAt: now,
              },
              {
                id: "thread-b",
                ownerId: "owner",
                workspaceId: "workspace-b",
                createdByUserId: "user",
                executorKind: "runner",
                inheritProjectGrants: false,
                createdAt: now,
              },
            ])
          }),
        )
        const postgresContext = yield* Layer.build(
          PgClient.layerFrom(PgClient.make({ url: Redacted.make(url), maxConnections: 4 })),
        )
        const repositoryContext = yield* Layer.build(
            productRepositoryLayer.pipe(Layer.provide(Layer.succeedContext(postgresContext))),
        )
        const repository = Context.get(repositoryContext, ProductRepository)
        const clientAuthority: HostedClientAuthorityService = {
          registerDevice: unused,
          authenticateClient: unused,
          grantClientAuthority: unused,
          findThread: unused,
          readThread: unused,
          authorizeThread: (input) =>
            input.threadId === "thread-private"
              ? Effect.fail(HostedPersistenceError.make({ reason: "invalid-authority", message: "private" }))
              : Effect.void,
        }
        const authority = makeRepositoryProductAuthority({
          identity,
          devices: {
            register: unused,
            discard: unused,
            authenticate: () => Effect.succeed("device"),
            list: unused,
            revoke: unused,
            revokeAll: unused,
          },
          product: repository,
          clientAuthority,
          environment: "test",
          binding: () => Effect.die("unused route fixture binding"),
        })
        const gateway = {
          ensureRootSession: () => Effect.succeed({ sessionId: "unused", created: false }),
          handle: () => Effect.succeed(new Response("unused")),
        }
        const first = yield* handleApiV2Request({
          authority,
          product: authority.product,
          gateway,
          environment: "test",
          request: new Request("https://rika.test/api/v2/threads?limit=1", {
            headers: { authorization: "Bearer valid" },
          }),
        })
        expect(first.status).toBe(200)
        const firstPage = yield* responseJson(first).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ThreadPage)))
        expect(firstPage).toMatchObject({
          threads: [
            {
              id: "thread-a",
              title: "Visible A",
              target: "runner",
              sessionId: "rika-v2:owner:thread-a",
            },
          ],
        })
        const cursor = firstPage.nextCursor
        expect(cursor).toEqual(expect.any(String))
        expect(Buffer.from(cursor!, "base64url").toString()).toContain('"threadId":"thread-a"')
        const second = yield* handleApiV2Request({
          authority,
          product: authority.product,
          gateway,
          environment: "test",
          request: new Request(`https://rika.test/api/v2/threads?limit=1&cursor=${String(cursor)}`, {
            headers: { authorization: "Bearer valid" },
          }),
        })
        expect(second.status).toBe(200)
        expect(yield* responseJson(second)).toMatchObject({
          threads: [
            {
              id: "thread-b",
              title: "Visible B",
              target: "runner",
              sessionId: "rika-v2:owner:thread-b",
            },
          ],
          nextCursor: null,
        })
        const denied = yield* handleApiV2Request({
          authority,
          product: authority.product,
          gateway,
          environment: "test",
          request: new Request("https://rika.test/api/v2/threads/thread-private", {
            headers: { authorization: "Bearer valid" },
          }),
        })
        expect(denied.status).toBe(404)
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ),
)
