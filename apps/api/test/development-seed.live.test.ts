import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, makeBetterAuthIdentityRuntime, noOpMailSender, runMigration } from "@rika/identity"
import { BetterAuthUserId } from "@rika/product/hosted-model"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import { Config, Context, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { developmentAccount, seedDevelopment } from "../src/development-seed"
import { HostedProduct, postgresTest } from "../src/hosted-product"
import { HostedProviderCredentials, layer as credentialsLayer } from "../src/hosted-provider-credentials"
import { live as livePlatform } from "./live-platform"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const encryptionKey = Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
const openRouterApiKey = Redacted.make("development-openrouter-key")
const query = <A extends Record<string, unknown>>(pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.tryPromise(() => pool.query<A>(text, [...values])).pipe(Effect.map((result) => result.rows))

interface SeededCredentialRow extends Record<string, unknown> {
  readonly credential_identity: string
  readonly owner_id: string
  readonly revision: string
  readonly userId: string | null
  readonly status: "active" | "revoked"
  readonly keyVersion: number | null
  readonly nonce: string | null
  readonly ciphertext: string | null
  readonly authenticationTag: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly rotatedAt: string | null
  readonly revokedAt: string | null
}

const readCredentials = (pool: Pool) =>
  query<SeededCredentialRow>(
    pool,
    `SELECT credential.credential_reference_id AS credential_identity, credential.owner_id,
       credential.revision::text AS revision, owner_record.user_id AS "userId", credential.status,
       credential.key_version AS "keyVersion", encode(credential.nonce, 'hex') AS nonce,
       encode(credential.ciphertext, 'hex') AS ciphertext,
       encode(credential.authentication_tag, 'hex') AS "authenticationTag",
       credential.created_at::text AS "createdAt", credential.updated_at::text AS "updatedAt",
       credential.rotated_at::text AS "rotatedAt", credential.revoked_at::text AS "revokedAt"
     FROM rika_hosted_provider_credentials credential
     JOIN rika_hosted_owners owner_record ON owner_record.id = credential.owner_id
     ORDER BY credential.owner_id`,
  )

it.effect.skipIf(databaseUrl === "")("seeds one stable encrypted development account repeatedly in PostgreSQL", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_development_seed_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
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
          identity,
          pool,
          product: Context.get(productContext, HostedProduct),
          credentials,
          openRouterApiKey,
        }

        yield* Effect.all([seedDevelopment(input), seedDevelopment(input)], { concurrency: 2, discard: true })
        const first = yield* readCredentials(pool)
        yield* seedDevelopment(input)
        const second = yield* readCredentials(pool)

        expect(second).toEqual(first)
        expect(second).toHaveLength(2)
        expect(second.map((row) => row.revision)).toEqual(["1", "1"])
        const rotatedInput = { ...input, openRouterApiKey: Redacted.make("replacement-development-openrouter-key") }
        yield* seedDevelopment(rotatedInput)
        const rotated = yield* readCredentials(pool)
        expect(rotated.map((row) => row.revision)).toEqual(["2", "2"])
        expect(rotated.map((row) => row.credential_identity)).toEqual(second.map((row) => row.credential_identity))
        expect(rotated.map((row) => row.ciphertext)).not.toEqual(second.map((row) => row.ciphertext))
        yield* seedDevelopment(rotatedInput)
        expect(yield* readCredentials(pool)).toEqual(rotated)
        const personalCredential = second.find((row) => row.userId !== null)
        if (personalCredential?.userId === null || personalCredential === undefined)
          return yield* Effect.die("Development personal credential was not seeded")
        yield* credentials.revoke({
          principal: { userId: personalCredential.userId, deviceId: "device", clientId: "client" },
          owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make(personalCredential.userId) },
          provider: "openrouter",
        })
        yield* seedDevelopment(rotatedInput)
        const replaced = yield* readCredentials(pool)
        expect(replaced.find((row) => row.userId !== null)).toMatchObject({
          credential_identity: personalCredential.credential_identity,
          revision: "4",
          status: "active",
        })
        expect(replaced.find((row) => row.userId === null)).toEqual(rotated.find((row) => row.userId === null))
        expect(
          yield* query<{ readonly users: number; readonly organizations: number; readonly members: number }>(
            pool,
            `SELECT
              (SELECT count(*)::int FROM "user" WHERE email = $1) AS users,
              (SELECT count(*)::int FROM "organization" WHERE slug = $2) AS organizations,
              (SELECT count(*)::int FROM "member" member_record
                JOIN "organization" organization_record ON organization_record.id = member_record.organization_id
                JOIN "user" user_record ON user_record.id = member_record.user_id
                WHERE organization_record.slug = $2 AND user_record.email = $1) AS members`,
            [developmentAccount.email, developmentAccount.organizationSlug],
          ),
        ).toEqual([{ users: 1, organizations: 1, members: 1 }])
        expect(
          yield* query<{ readonly owners: number; readonly credentials: number; readonly encrypted: boolean }>(
            pool,
            `SELECT
              (SELECT count(*)::int FROM rika_hosted_owners
                WHERE user_id = (SELECT id FROM "user" WHERE email = $2)
                  OR organization_id = (SELECT id FROM "organization" WHERE slug = $3)) AS owners,
              count(*)::int AS credentials,
              bool_and(key_version = 1 AND nonce IS NOT NULL AND ciphertext IS NOT NULL
                AND authentication_tag IS NOT NULL AND ciphertext <> convert_to($1, 'UTF8')) AS encrypted
             FROM rika_hosted_provider_credentials`,
            [Redacted.value(openRouterApiKey), developmentAccount.email, developmentAccount.organizationSlug],
          ),
        ).toEqual([{ owners: 2, credentials: 2, encrypted: true }])
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform),
)
