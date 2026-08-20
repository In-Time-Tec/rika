import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { Effect, Layer, Random, Redacted } from "effect"
import { Pool, type QueryResult } from "pg"
import { HostedProduct, HostedProductError, postgres, type AuthenticatedPrincipal } from "../src/hosted-product"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined

const principal = (userId: string): AuthenticatedPrincipal => ({
  userId,
  deviceId: `device-${userId}`,
  clientId: `client-${userId}`,
})

const personal = (userId: string) => ({ _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(userId) })
const organization = (organizationId: string) => ({
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make(organizationId),
})

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

const user = (pool: Pool, id: string) =>
  query(
    pool,
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ($1, $1, $2, true, now(), now())`,
    [id, `${id}@example.test`],
  )

const org = (pool: Pool, id: string) =>
  query(pool, `INSERT INTO "organization" (id, name, slug, created_at) VALUES ($1, $1, $1, now())`, [id])

const member = (pool: Pool, id: string, organizationId: string, userId: string) =>
  query(
    pool,
    `INSERT INTO "member" (id, organization_id, user_id, role, created_at)
      VALUES ($1, $2, $3, 'member', now())`,
    [id, organizationId, userId],
  )

const failureKind = <A>(effect: Effect.Effect<A, HostedProductError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.kind),
  )

const withDatabase = <A, E, R>(label: string, use: (pool: Pool) => Effect.Effect<A, E, R | HostedProduct>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_product_${label}_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        pool = new Pool({ connectionString: url })
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const context = yield* Layer.build(
          postgres({
            database: { url: Redacted.make(url), maxConnections: 8 },
            templateBuildId: "hosted-product-live",
            providerScope: "hosted-product-live",
          }).pipe(Layer.provide(BunCrypto.layer)),
        )
        return yield* use(pool).pipe(Effect.provide(context))
      } finally {
        yield* Effect.promise(() => pool?.end() ?? Promise.resolve())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  )

it.effect.skipIf(!live)("supports a projectless personal connection for a user with no organizations", () =>
  withDatabase("personal", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "personal-user")
      const product = yield* HostedProduct
      expect(yield* product.projects(principal("personal-user"))).toEqual([])
      const connection = yield* product.createConnection({
        principal: principal("personal-user"),
        owner: personal("personal-user"),
        placement: "local",
      })
      yield* product.admitRun({
        principal: principal("personal-user"),
        threadId: connection.threadId,
        operationKey: "personal-operation",
        prompt: "personal prompt",
      })
      const facts = yield* query(
        pool,
        `SELECT owner_record.id AS owner_id, owner_record.user_id, thread.created_by_user_id,
          command.actor, (SELECT count(*)::int FROM "member" WHERE user_id = $1) AS memberships
        FROM rika_hosted_thread_commands command
        JOIN rika_hosted_threads thread ON thread.id = command.thread_id
        JOIN rika_hosted_owners owner_record ON owner_record.id = command.owner_id`,
        ["personal-user"],
      )
      expect(facts.rows).toHaveLength(1)
      expect(facts.rows[0]).toMatchObject({
        user_id: "personal-user",
        created_by_user_id: "personal-user",
        memberships: 0,
        actor: { _tag: "PersonalActor", userId: "personal-user", owner: personal("personal-user") },
      })
    }),
  ),
)

it.effect.skipIf(!live)("revokes organization admission immediately without affecting personal threads", () =>
  withDatabase("revocation", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "member-user")
      yield* org(pool, "revoked-org")
      yield* member(pool, "revoked-membership", "revoked-org", "member-user")
      const product = yield* HostedProduct
      const personalConnection = yield* product.createConnection({
        principal: principal("member-user"),
        owner: personal("member-user"),
        placement: "local",
      })
      const organizationConnection = yield* product.createConnection({
        principal: principal("member-user"),
        owner: organization("revoked-org"),
        placement: "local",
      })
      yield* product.admitRun({
        principal: principal("member-user"),
        threadId: organizationConnection.threadId,
        operationKey: "org-before-revocation",
        prompt: "allowed",
      })
      yield* query(pool, `DELETE FROM "member" WHERE id = 'revoked-membership'`)
      expect(
        yield* failureKind(
          product.admitRun({
            principal: principal("member-user"),
            threadId: organizationConnection.threadId,
            operationKey: "org-after-revocation",
            prompt: "denied",
          }),
        ),
      ).toBe("forbidden")
      yield* product.admitRun({
        principal: principal("member-user"),
        threadId: personalConnection.threadId,
        operationKey: "personal-after-revocation",
        prompt: "still allowed",
      })
    }),
  ),
)

it.effect.skipIf(!live)("requires a direct grant for a non-creator organization projectless thread", () =>
  withDatabase("grant", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "creator-user")
      yield* user(pool, "operator-user")
      yield* org(pool, "grant-org")
      yield* member(pool, "creator-membership", "grant-org", "creator-user")
      yield* member(pool, "operator-membership", "grant-org", "operator-user")
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: principal("creator-user"),
        owner: organization("grant-org"),
        placement: "local",
      })
      const operate = product.admitRun({
        principal: principal("operator-user"),
        threadId: connection.threadId,
        operationKey: "operator-run",
        prompt: "operate",
      })
      expect(yield* failureKind(operate)).toBe("forbidden")
      const owner = yield* query(pool, `SELECT owner_id FROM rika_hosted_threads WHERE id = $1`, [connection.threadId])
      yield* query(
        pool,
        `INSERT INTO rika_hosted_thread_grants
          (owner_id, thread_id, membership_id, role, granted_by_user_id, created_at, updated_at)
          VALUES ($1, $2, 'operator-membership', 'operator', 'creator-user', now(), now())`,
        [owner.rows[0].owner_id, connection.threadId],
      )
      yield* operate
      const command = yield* query(
        pool,
        `SELECT actor FROM rika_hosted_thread_commands WHERE command_id = 'operator-run'`,
      )
      expect(command.rows[0].actor).toMatchObject({
        _tag: "OrganizationActor",
        userId: "operator-user",
        membershipId: "operator-membership",
        owner: organization("grant-org"),
      })
    }),
  ),
)

it.effect.skipIf(!live)("fails closed for forged and cross-owner selections", () =>
  withDatabase("forgery", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "first-user")
      yield* user(pool, "second-user")
      yield* org(pool, "foreign-org")
      const product = yield* HostedProduct
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: personal("second-user"),
            placement: "local",
          }),
        ),
      ).toBe("forbidden")
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: organization("foreign-org"),
            placement: "local",
          }),
        ),
      ).toBe("forbidden")
      const secondConnection = yield* product.createConnection({
        principal: principal("second-user"),
        owner: personal("second-user"),
        placement: "local",
      })
      expect(
        yield* failureKind(
          product.admitRun({
            principal: principal("first-user"),
            threadId: secondConnection.threadId,
            operationKey: "foreign-thread",
            prompt: "denied",
          }),
        ),
      ).toBe("forbidden")
      yield* product.projects(principal("first-user"))
      const secondOwner = yield* query(pool, `SELECT id FROM rika_hosted_owners WHERE user_id = 'second-user'`)
      yield* query(
        pool,
        `INSERT INTO rika_hosted_projects (id, owner_id, name, created_by_user_id, created_at, updated_at)
          VALUES ('foreign-project', $1, 'Foreign', 'second-user', now(), now())`,
        [secondOwner.rows[0].id],
      )
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: personal("first-user"),
            projectId: "foreign-project",
            placement: "local",
          }),
        ),
      ).toBe("not-found")
    }),
  ),
)

it.effect.skipIf(!live)("provisions stable opaque personal and organization owners under concurrency", () =>
  withDatabase("owners", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "owner-user")
      yield* org(pool, "owner-org")
      yield* member(pool, "owner-membership", "owner-org", "owner-user")
      const product = yield* HostedProduct
      yield* Effect.all(
        Array.from({ length: 8 }, () => product.projects(principal("owner-user"))),
        {
          concurrency: "unbounded",
        },
      )
      const owners: QueryResult<{ id: string; kind: string }> = yield* query(
        pool,
        `SELECT id, kind FROM rika_hosted_owners ORDER BY kind`,
      )
      expect(owners.rows).toHaveLength(2)
      expect(owners.rows.map(({ kind }) => kind).sort()).toEqual(["organization", "personal"])
      expect(owners.rows.every(({ id }) => id !== "owner-user" && id !== "owner-org")).toBe(true)
      yield* product.projects(principal("owner-user"))
      const repeated = yield* query(pool, `SELECT id, kind FROM rika_hosted_owners ORDER BY kind`)
      expect(repeated.rows).toEqual(owners.rows)
    }),
  ),
)
