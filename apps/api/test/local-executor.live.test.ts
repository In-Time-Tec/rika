import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as productPostgres } from "@rika/product-store/postgres-layer"
import type { Access } from "@rika/remote-execution/protocol"
import { Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { testLayer as hostedModelRegistryTestLayer } from "../src/hosted-model-registry"
import { HostedProduct, layer as hostedProductLayer, type AuthenticatedPrincipal } from "../src/hosted-product"
import { LocalExecutor, layer as localExecutorLayer } from "../src/local-executor"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

const personal = (userId: string) => ({ _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(userId) })
const organization = (organizationId: string) => ({
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make(organizationId),
})

const principal = (userId: string, clientId: string, deviceId: string): AuthenticatedPrincipal => ({
  userId,
  clientId,
  deviceId,
  dpopJkt: `thumbprint-${clientId}`,
})

const seedPrincipal = (pool: Pool, input: AuthenticatedPrincipal) =>
  Effect.gen(function* () {
    yield* query(
      pool,
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $1, $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [input.userId, `${input.userId}@example.test`],
    )
    yield* query(
      pool,
      `INSERT INTO oauth_client (id, client_id, user_id, redirect_uris, created_at)
       VALUES ($1, $1, $2, '[]'::jsonb, now())`,
      [input.clientId, input.userId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_cli_registration
         (client_id, device_id, public_jwk, jwk_thumbprint, user_id)
       VALUES ($1, $2::uuid,
         '{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
         $3, $4)`,
      [input.clientId, input.deviceId, input.dpopJkt, input.userId],
    )
  })

const accessFrom = (welcome: Access): Access => ({
  version: welcome.version,
  fence: welcome.fence,
  leaseEpoch: welcome.leaseEpoch,
  sessionToken: welcome.sessionToken,
})

const failureKind = <A>(effect: Effect.Effect<A, { readonly kind: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.kind),
  )

const isolated = <A, E, R>(
  label: string,
  use: (pool: Pool) => Effect.Effect<A, E, R | HostedProduct | LocalExecutor>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_local_authority_${label}_${Math.abs(yield* Random.nextInt)}`
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
        const base = Layer.mergeAll(
          productPostgres({ url: Redacted.make(url), maxConnections: 8 }),
          AuthorizationPolicy.layer,
          BunCrypto.layer,
          hostedModelRegistryTestLayer,
        )
        const context = yield* Layer.build(
          Layer.merge(
            hostedProductLayer({ templateBuildId: "local-authority-live", providerScope: "local-authority-live" }),
            localExecutorLayer,
          ).pipe(Layer.provide(base)),
        )
        return yield* use(pool).pipe(Effect.provide(context))
      } finally {
        yield* Effect.promise(() => pool?.end() ?? Promise.resolve())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  )

it.effect.skipIf(!live)("keeps real personal local authority active without organization membership", () =>
  isolated("personal", (pool) =>
    Effect.gen(function* () {
      const owner = principal("personal-user", "personal-client", "10000000-0000-4000-8000-000000000001")
      yield* seedPrincipal(pool, owner)
      const product = yield* HostedProduct
      const authority = yield* LocalExecutor
      const connection = yield* product.createConnection({
        principal: owner,
        owner: personal(owner.userId),
        placement: "local",
      })
      expect((yield* query(pool, `SELECT count(*)::int AS count FROM member`)).rows).toEqual([{ count: 0 }])
      const admission = yield* authority.admit({
        threadId: connection.threadId,
        workspaceFingerprint: "personal-workspace",
        principal: owner,
        executorUrl: "ws://executor.test/local",
      })
      const welcome = yield* authority.hello({
        admissionId: admission.admissionId,
        ticket: admission.ticket,
        processIncarnation: "personal-process",
      })
      const access = accessFrom(welcome)
      yield* authority.validateAccess(access)
      const reconnected = yield* authority.reconnect(access)
      yield* authority.heartbeat({
        version: 1,
        access: { ...access, leaseEpoch: reconnected.leaseEpoch },
        cursor: reconnected.cursor,
      })
      expect(
        (yield* query(pool, `SELECT consumed_at IS NOT NULL AS consumed FROM rika_hosted_local_executor_admissions`))
          .rows,
      ).toEqual([{ consumed: true }])
    }),
  ),
)

it.effect.skipIf(!live)("fences organization access immediately while preserving a personal session", () =>
  isolated("membership", (pool) =>
    Effect.gen(function* () {
      const owner = principal("shared-user", "shared-client", "20000000-0000-4000-8000-000000000002")
      yield* seedPrincipal(pool, owner)
      yield* query(
        pool,
        `INSERT INTO organization (id, name, slug, created_at) VALUES ('local-org', 'Local org', 'local-org', now())`,
      )
      yield* query(
        pool,
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
         VALUES ('local-member', 'local-org', $1, 'member', now())`,
        [owner.userId],
      )
      const product = yield* HostedProduct
      const authority = yield* LocalExecutor
      const personalConnection = yield* product.createConnection({
        principal: owner,
        owner: personal(owner.userId),
        placement: "local",
      })
      const organizationConnection = yield* product.createConnection({
        principal: owner,
        owner: organization("local-org"),
        placement: "local",
      })
      const open = (threadId: string, label: string) =>
        Effect.gen(function* () {
          const admission = yield* authority.admit({
            threadId,
            workspaceFingerprint: `${label}-workspace`,
            principal: owner,
            executorUrl: "ws://executor.test/local",
          })
          return yield* authority.hello({
            admissionId: admission.admissionId,
            ticket: admission.ticket,
            processIncarnation: `${label}-process`,
          })
        })
      const personalWelcome = yield* open(personalConnection.threadId, "personal")
      const organizationWelcome = yield* open(organizationConnection.threadId, "organization")
      const personalAccess = accessFrom(personalWelcome)
      const organizationAccess = accessFrom(organizationWelcome)
      yield* authority.validateAccess(organizationAccess)
      yield* query(pool, `DELETE FROM member WHERE id = 'local-member'`)
      for (const operation of [
        authority.validateAccess(organizationAccess),
        authority.reconnect(organizationAccess),
        authority.heartbeat({ version: 1, access: organizationAccess, cursor: organizationWelcome.cursor }),
      ]) {
        expect(["authentication", "fenced"]).toContain(yield* failureKind(operation))
      }
      yield* authority.validateAccess(personalAccess)
      const personalReconnect = yield* authority.reconnect(personalAccess)
      yield* authority.heartbeat({
        version: 1,
        access: { ...personalAccess, leaseEpoch: personalReconnect.leaseEpoch },
        cursor: personalReconnect.cursor,
      })
    }),
  ),
)

it.effect.skipIf(!live)("rejects cross-owner and cross-device admissions before issuing usable tickets", () =>
  isolated("cross_binding", (pool) =>
    Effect.gen(function* () {
      const owner = principal("owner-user", "owner-client", "30000000-0000-4000-8000-000000000003")
      const stranger = principal("stranger-user", "stranger-client", "40000000-0000-4000-8000-000000000004")
      const otherDevice = principal("owner-user", "other-client", "50000000-0000-4000-8000-000000000005")
      yield* seedPrincipal(pool, owner)
      yield* seedPrincipal(pool, stranger)
      yield* seedPrincipal(pool, otherDevice)
      const product = yield* HostedProduct
      const authority = yield* LocalExecutor
      const connection = yield* product.createConnection({
        principal: owner,
        owner: personal(owner.userId),
        placement: "local",
      })
      expect(
        yield* failureKind(
          authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: "cross-owner",
            principal: stranger,
            executorUrl: "ws://executor.test/local",
          }),
        ),
      ).toBe("fenced")
      expect(
        yield* failureKind(
          authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: "cross-device",
            principal: otherDevice,
            executorUrl: "ws://executor.test/local",
          }),
        ),
      ).toBe("fenced")
      expect(
        (yield* query(pool, `SELECT count(*)::int AS count FROM rika_hosted_local_executor_admissions`)).rows,
      ).toEqual([{ count: 0 }])
    }),
  ),
)
