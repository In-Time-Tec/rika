import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMember, identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import { BetterAuthUserId, OrganizationId, OwnerId } from "@rika/product/hosted-model"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import {
  rikaHostedCredentialReferences,
  rikaHostedOpenaiAccountCredentials,
  rikaHostedOwners,
  rikaHostedProviderCredentials,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as postgresLayer } from "@rika/product-store/layer"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { FileSystem, Config, Context, DateTime, Effect, Layer, Option, Random, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import { HostedModelRegistry, layer as modelRegistryLayer } from "../../../src/hosted/environment/model-registry"
import {
  HostedProviderCredentialError,
  HostedProviderCredentials,
  layer as credentialsLayer,
  storeLayer,
} from "../../../src/hosted/environment/provider-credentials"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const key = Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
type JwtPayload = Schema.Json
const principal = (userId: string) => ({ userId, deviceId: `device-${userId}`, clientId: `client-${userId}` })
const personal = (userId: string) => ({ _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(userId) })
const organization = (organizationId: string) => ({
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make(organizationId),
})
const jwt = (payload: JwtPayload) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`

const failureKind = <A>(effect: Effect.Effect<A, HostedProviderCredentialError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.kind),
  )

it.effect.skipIf(databaseUrl === "")("encrypts, rotates, revokes, and resolves owner-scoped provider credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_provider_credentials_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
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
        const db = drizzle({ client: pool })
        const createdAt = DateTime.toDate(DateTime.nowUnsafe())
        yield* Effect.tryPromise(() =>
          db.insert(identityUser).values([
            {
              id: "owner-user",
              name: "owner-user",
              email: "owner@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            },
            {
              id: "other-user",
              name: "other-user",
              email: "other@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          db.insert(rikaHostedOwners).values({ id: "personal-owner", kind: "personal", userId: "owner-user" }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(identityOrganization).values({
            id: "organization-1",
            name: "organization-1",
            slug: "organization-1",
            createdAt,
          }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(identityMember).values([
            {
              id: "organization-owner",
              organizationId: "organization-1",
              userId: "owner-user",
              role: "owner",
              createdAt,
            },
            {
              id: "organization-member",
              organizationId: "organization-1",
              userId: "other-user",
              role: "member",
              createdAt,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          db
            .insert(rikaHostedOwners)
            .values({ id: "organization-owner-record", kind: "organization", organizationId: "organization-1" }),
        )
        const accountIdentity = {
          "https://api.openai.com/auth": {
            chatgpt_account_id: "chatgpt-account-1",
            chatgpt_user_id: "chatgpt-user-1",
          },
        }
        const firstAccessToken = jwt({ exp: 4_000_000_000 })
        const firstIdToken = jwt(accountIdentity)
        const secondAccessToken = jwt({ exp: 4_000_000_001 })
        let refreshes = 0
        const base = Layer.mergeAll(
          postgresLayer({ url: Redacted.make(url), maxConnections: 4 }),
          BunCrypto.layer,
          Layer.succeed(
            OpenAiAuth.Http,
            OpenAiAuth.Http.of({
              exchange: () => Effect.die("unused"),
              refresh: () =>
                Effect.sync(() => {
                  refreshes += 1
                  return {
                    access_token: secondAccessToken,
                    id_token: firstIdToken,
                    refresh_token: "oauth-refresh-secret-two",
                  }
                }),
              deviceStart: Effect.die("unused"),
              devicePoll: () => Effect.die("unused"),
            }),
          ),
        )
        const credentialContext = yield* Layer.build(
          Layer.merge(credentialsLayer({ encryptionKey: key }), storeLayer({ encryptionKey: key })).pipe(
            Layer.provide(base),
          ),
        )
        const context = Context.merge(
          credentialContext,
          yield* Layer.build(modelRegistryLayer().pipe(Layer.provide(Layer.succeedContext(credentialContext)))),
        )
        const credentials = Context.get(context, HostedProviderCredentials)
        const store = Context.get(context, ProviderCredentialStore)
        const models = Context.get(context, HostedModelRegistry)
        expect(yield* failureKind(credentials.require(OwnerId.make("personal-owner"), "openrouter"))).toBe("missing")
        expect(
          yield* failureKind(
            credentials.put({
              principal: principal("other-user"),
              owner: personal("owner-user"),
              provider: "openrouter",
              apiKey: Redacted.make("must-not-write"),
            }),
          ),
        ).toBe("forbidden")
        expect(
          yield* failureKind(
            credentials.put({
              principal: principal("other-user"),
              owner: organization("organization-1"),
              provider: "anthropic",
              apiKey: Redacted.make("must-not-write"),
            }),
          ),
        ).toBe("forbidden")
        const organizationCredential = yield* credentials.put({
          principal: principal("owner-user"),
          owner: organization("organization-1"),
          provider: "anthropic",
          apiKey: Redacted.make("organization-provider-secret"),
        })
        expect(organizationCredential).toMatchObject({ provider: "anthropic", state: "active", revision: "1" })
        const first = yield* credentials.put({
          principal: principal("owner-user"),
          owner: personal("owner-user"),
          provider: "openrouter",
          apiKey: Redacted.make("provider-secret-one"),
        })
        expect(first).toMatchObject({ provider: "openrouter", state: "active", revision: "1" })
        const firstLoaded = yield* store.load(first.credentialIdentity)
        expect(Option.isSome(firstLoaded) && Redacted.value(firstLoaded.value)).toBe("provider-secret-one")
        expect(
          yield* credentials.put({
            principal: principal("owner-user"),
            owner: personal("owner-user"),
            provider: "openrouter",
            apiKey: Redacted.make("provider-secret-one"),
          }),
        ).toEqual(first)
        expect(
          yield* credentials.openAiAccountStatus({
            principal: principal("owner-user"),
            owner: personal("owner-user"),
          }),
        ).toEqual({ state: "missing" })
        const openAiAccount = yield* credentials.putOpenAiAccount({
          principal: principal("owner-user"),
          owner: personal("owner-user"),
          accessToken: Redacted.make(firstAccessToken),
          idToken: Redacted.make(firstIdToken),
          refreshToken: Redacted.make("oauth-refresh-secret-one"),
        })
        expect(openAiAccount).toMatchObject({ state: "active", revision: "1" })
        const accountAccess = credentials.openAiAccountAccess(openAiAccount.credentialIdentity)
        const acquired = yield* accountAccess.acquire
        expect(Redacted.value(acquired.accessToken)).toBe(firstAccessToken)
        expect(Redacted.value(acquired.refreshToken)).toBe("oauth-refresh-secret-one")
        expect(acquired.fingerprint).toBe(openAiAccount.fingerprint)
        const refreshed = yield* accountAccess.refreshRejected(acquired.generation)
        expect(refreshes).toBe(1)
        expect(Redacted.value(refreshed.accessToken)).toBe(secondAccessToken)
        expect(Redacted.value(refreshed.refreshToken)).toBe("oauth-refresh-secret-two")
        expect(refreshed.fingerprint).toBe(openAiAccount.fingerprint)
        const route = yield* models.resolve("personal-owner", "medium")
        expect(route.main.candidates[0]!.providerConnection).toMatchObject({
          authentication: "account",
          credentialIdentity: openAiAccount.credentialIdentity,
          accountFingerprint: openAiAccount.fingerprint,
        })
        expect(encodeJson(route)).not.toContain("provider-secret-one")
        expect(encodeJson(route)).not.toContain("provider-secret-two")
        const databaseRecord = yield* Effect.tryPromise(() =>
          db
            .select({
              ciphertext: sql`encode(${rikaHostedProviderCredentials.ciphertext}, 'escape')`.mapWith(String),
              external_reference: rikaHostedCredentialReferences.externalReference,
              metadata: sql`${rikaHostedCredentialReferences.metadata}::text`.mapWith(String),
            })
            .from(rikaHostedProviderCredentials)
            .innerJoin(
              rikaHostedCredentialReferences,
              eq(rikaHostedCredentialReferences.id, rikaHostedProviderCredentials.credentialReferenceId),
            )
            .where(eq(rikaHostedProviderCredentials.ownerId, "personal-owner")),
        )
        expect(encodeJson(databaseRecord)).not.toContain("provider-secret-one")
        expect(encodeJson(databaseRecord)).not.toContain("provider-secret-two")
        const accountDatabaseRecord = yield* Effect.tryPromise(() =>
          db
            .select({
              ciphertext: sql`encode(${rikaHostedOpenaiAccountCredentials.ciphertext}, 'escape')`.mapWith(String),
              fingerprint: rikaHostedOpenaiAccountCredentials.fingerprint,
            })
            .from(rikaHostedOpenaiAccountCredentials)
            .where(eq(rikaHostedOpenaiAccountCredentials.ownerId, "personal-owner")),
        )
        const encodedAccountRecord = encodeJson(accountDatabaseRecord)
        for (const secret of [
          firstAccessToken,
          firstIdToken,
          secondAccessToken,
          "oauth-refresh-secret-one",
          "oauth-refresh-secret-two",
        ])
          expect(encodedAccountRecord).not.toContain(secret)
        const rotated = yield* credentials.put({
          principal: principal("owner-user"),
          owner: personal("owner-user"),
          provider: "openrouter",
          apiKey: Redacted.make("provider-secret-two"),
        })
        expect(rotated).toMatchObject({
          credentialIdentity: first.credentialIdentity,
          state: "active",
          revision: "2",
        })
        const rotatedLoaded = yield* store.load(rotated.credentialIdentity)
        expect(Option.isSome(rotatedLoaded) && Redacted.value(rotatedLoaded.value)).toBe("provider-secret-two")
        expect(
          yield* credentials.list({ principal: principal("owner-user"), owner: personal("owner-user") }),
        ).toHaveLength(1)
        const revoked = yield* credentials.revoke({
          principal: principal("owner-user"),
          owner: personal("owner-user"),
          provider: "openrouter",
        })
        expect(revoked).toMatchObject({ state: "revoked", revision: "3" })
        expect(Option.isNone(yield* store.load(revoked.credentialIdentity))).toBe(true)
        expect(yield* failureKind(credentials.require("personal-owner", "openrouter"))).toBe("revoked")
        const cleared = yield* Effect.tryPromise(() =>
          db
            .select({
              ciphertext: rikaHostedProviderCredentials.ciphertext,
              nonce: rikaHostedProviderCredentials.nonce,
              authentication_tag: rikaHostedProviderCredentials.authenticationTag,
            })
            .from(rikaHostedProviderCredentials)
            .where(eq(rikaHostedProviderCredentials.ownerId, "personal-owner")),
        )
        expect(cleared).toEqual([{ ciphertext: null, nonce: null, authentication_tag: null }])
        const revokedAccount = yield* credentials.revokeOpenAiAccount({
          principal: principal("owner-user"),
          owner: personal("owner-user"),
        })
        expect(revokedAccount).toMatchObject({ state: "revoked", revision: "3" })
        expect(yield* Effect.flip(accountAccess.acquire)).toMatchObject({ kind: "login-required" })
        const clearedAccount = yield* Effect.tryPromise(() =>
          db
            .select({
              ciphertext: rikaHostedOpenaiAccountCredentials.ciphertext,
              nonce: rikaHostedOpenaiAccountCredentials.nonce,
              authentication_tag: rikaHostedOpenaiAccountCredentials.authenticationTag,
            })
            .from(rikaHostedOpenaiAccountCredentials)
            .where(eq(rikaHostedOpenaiAccountCredentials.ownerId, "personal-owner")),
        )
        expect(clearedAccount).toEqual([{ ciphertext: null, nonce: null, authentication_tag: null }])
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform),
)
