import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import {
  identityMember,
  identityMigrations,
  identityOrganization,
  identityUser,
  makeBetterAuthIdentityRuntime,
  noOpMailSender,
  runMigration,
} from "@rika/identity"
import { BetterAuthUserId } from "@rika/product/hosted-model"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import { rikaHostedOwners, rikaHostedProviderCredentials } from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as postgresLayer } from "@rika/product-store/layer"
import { and, asc, count, eq, or } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Config, Context, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { developmentAccount, seedDevelopment } from "../../src/development/seed"
import { HostedProduct, postgresTest } from "../../src/hosted/product"
import { HostedProviderCredentials, layer as credentialsLayer } from "../../src/hosted/environment/provider-credentials"
import { live as livePlatform } from "../support/live-platform"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const encryptionKey = Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
const openRouterApiKey = Redacted.make("development-openrouter-key")
const credentialSelection = {
  credential_identity: rikaHostedProviderCredentials.credentialReferenceId,
  owner_id: rikaHostedProviderCredentials.ownerId,
  revision: rikaHostedProviderCredentials.revision,
  userId: rikaHostedOwners.userId,
  status: rikaHostedProviderCredentials.status,
  keyVersion: rikaHostedProviderCredentials.keyVersion,
  nonce: rikaHostedProviderCredentials.nonce,
  ciphertext: rikaHostedProviderCredentials.ciphertext,
  authenticationTag: rikaHostedProviderCredentials.authenticationTag,
  createdAt: rikaHostedProviderCredentials.createdAt,
  updatedAt: rikaHostedProviderCredentials.updatedAt,
  rotatedAt: rikaHostedProviderCredentials.rotatedAt,
  revokedAt: rikaHostedProviderCredentials.revokedAt,
}

it.effect.skipIf(databaseUrl === "")("seeds one stable encrypted development account repeatedly in PostgreSQL", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_development_seed_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const databaseContext = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
      const identityDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(databaseContext))
      const databaseClient = drizzle({ client: pool })
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          yield* runMigration({
            pool,
            id: migration.id,
            checksum: migration.checksum,
            sql: yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
              fileSystem.readFileString(migration.url.pathname),
            ),
          })
        }
        const baseUrl = "http://127.0.0.1:3000"
        const identity = makeBetterAuthIdentityRuntime({
          config: {
            production: false,
            port: 3000,
            baseUrl,
            trustedOrigins: [baseUrl],
            authSecret: Redacted.make("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"),
            databaseUrl: Redacted.make(url),
            databaseSsl: "disable",
            resource: `${baseUrl}/api/v1`,
          },
          pool,
          mail: noOpMailSender,
        })
        const base = Layer.mergeAll(
          postgresLayer({ url: Redacted.make(url), maxConnections: 4 }),
          BunCrypto.layer,
          Layer.succeed(
            OpenAiAuth.Http,
            OpenAiAuth.Http.of({
              exchange: () => Effect.die("unused"),
              refresh: () => Effect.die("unused"),
              deviceStart: Effect.die("unused"),
              devicePoll: () => Effect.die("unused"),
            }),
          ),
        )
        const context = yield* Layer.build(credentialsLayer({ encryptionKey }).pipe(Layer.provide(base)))
        const credentials = Context.get(context, HostedProviderCredentials)
        const productContext = yield* Layer.build(
          postgresTest({
            database: { url: Redacted.make(url), maxConnections: 4 },
            templateBuildId: "development-seed-live",
            providerScope: "development-seed-live",
          }).pipe(Layer.provide(BunCrypto.layer)),
        )
        const input = {
          baseUrl,
          database: identityDatabase,
          identity,
          pool,
          product: Context.get(productContext, HostedProduct),
          credentials,
          openRouterApiKey,
        }

        yield* Effect.all([seedDevelopment(input), seedDevelopment(input)], { concurrency: 2, discard: true })
        const firstRows = yield* Effect.tryPromise(() =>
          databaseClient
            .select(credentialSelection)
            .from(rikaHostedProviderCredentials)
            .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProviderCredentials.ownerId))
            .orderBy(asc(rikaHostedProviderCredentials.ownerId)),
        )
        const first = firstRows.map((row) => ({ ...row, revision: String(row.revision) }))
        yield* seedDevelopment(input)
        const secondRows = yield* Effect.tryPromise(() =>
          databaseClient
            .select(credentialSelection)
            .from(rikaHostedProviderCredentials)
            .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProviderCredentials.ownerId))
            .orderBy(asc(rikaHostedProviderCredentials.ownerId)),
        )
        const second = secondRows.map((row) => ({ ...row, revision: String(row.revision) }))

        expect(second).toEqual(first)
        expect(second).toHaveLength(2)
        expect(second.map((row) => row.revision)).toEqual(["1", "1"])
        const rotatedInput = { ...input, openRouterApiKey: Redacted.make("replacement-development-openrouter-key") }
        yield* seedDevelopment(rotatedInput)
        const rotatedRows = yield* Effect.tryPromise(() =>
          databaseClient
            .select(credentialSelection)
            .from(rikaHostedProviderCredentials)
            .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProviderCredentials.ownerId))
            .orderBy(asc(rikaHostedProviderCredentials.ownerId)),
        )
        const rotated = rotatedRows.map((row) => ({ ...row, revision: String(row.revision) }))
        expect(rotated.map((row) => row.revision)).toEqual(["2", "2"])
        expect(rotated.map((row) => row.credential_identity)).toEqual(second.map((row) => row.credential_identity))
        expect(rotated.map((row) => row.ciphertext)).not.toEqual(second.map((row) => row.ciphertext))
        yield* seedDevelopment(rotatedInput)
        const repeatedRows = yield* Effect.tryPromise(() =>
          databaseClient
            .select(credentialSelection)
            .from(rikaHostedProviderCredentials)
            .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProviderCredentials.ownerId))
            .orderBy(asc(rikaHostedProviderCredentials.ownerId)),
        )
        expect(repeatedRows.map((row) => ({ ...row, revision: String(row.revision) }))).toEqual(rotated)
        const personalCredential = second.find((row) => row.userId !== null)
        if (personalCredential?.userId === null || personalCredential === undefined)
          return yield* Effect.die("Development personal credential was not seeded")
        yield* credentials.revoke({
          principal: { userId: personalCredential.userId, deviceId: "device", clientId: "client" },
          owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make(personalCredential.userId) },
          provider: "openrouter",
        })
        yield* seedDevelopment(rotatedInput)
        const replacedRows = yield* Effect.tryPromise(() =>
          databaseClient
            .select(credentialSelection)
            .from(rikaHostedProviderCredentials)
            .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProviderCredentials.ownerId))
            .orderBy(asc(rikaHostedProviderCredentials.ownerId)),
        )
        const replaced = replacedRows.map((row) => ({ ...row, revision: String(row.revision) }))
        expect(replaced.find((row) => row.userId !== null)).toMatchObject({
          credential_identity: personalCredential.credential_identity,
          revision: "4",
          status: "active",
        })
        expect(replaced.find((row) => row.userId === null)).toEqual(rotated.find((row) => row.userId === null))
        const [users, organizations, memberCounts] = yield* Effect.all([
          Effect.orDie(
            Effect.tryPromise(() =>
              databaseClient.$count(identityUser, eq(identityUser.email, developmentAccount.email)),
            ),
          ),
          Effect.orDie(
            Effect.tryPromise(() =>
              databaseClient.$count(
                identityOrganization,
                eq(identityOrganization.slug, developmentAccount.organizationSlug),
              ),
            ),
          ),
          Effect.orDie(
            Effect.tryPromise(() =>
              databaseClient
                .select({ members: count() })
                .from(identityMember)
                .innerJoin(identityOrganization, eq(identityOrganization.id, identityMember.organizationId))
                .innerJoin(identityUser, eq(identityUser.id, identityMember.userId))
                .where(
                  and(
                    eq(identityOrganization.slug, developmentAccount.organizationSlug),
                    eq(identityUser.email, developmentAccount.email),
                  ),
                ),
            ),
          ),
        ])
        expect([{ users, organizations, members: memberCounts[0]?.members ?? 0 }]).toEqual([
          { users: 1, organizations: 1, members: 1 },
        ])
        const ownerCounts = yield* Effect.tryPromise(() =>
          databaseClient
            .select({ owners: count() })
            .from(rikaHostedOwners)
            .leftJoin(identityUser, eq(identityUser.id, rikaHostedOwners.userId))
            .leftJoin(identityOrganization, eq(identityOrganization.id, rikaHostedOwners.organizationId))
            .where(
              or(
                eq(identityUser.email, developmentAccount.email),
                eq(identityOrganization.slug, developmentAccount.organizationSlug),
              ),
            ),
        )
        const encrypted = replaced.every(
          (row) =>
            row.keyVersion === 1 &&
            Buffer.isBuffer(row.nonce) &&
            Buffer.isBuffer(row.ciphertext) &&
            Buffer.isBuffer(row.authenticationTag) &&
            !row.ciphertext.equals(Buffer.from(Redacted.value(openRouterApiKey))),
        )
        expect([
          {
            owners: ownerCounts[0]?.owners ?? 0,
            credentials: replaced.length,
            encrypted,
          },
        ]).toEqual([{ owners: 2, credentials: 2, encrypted: true }])
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform),
)
