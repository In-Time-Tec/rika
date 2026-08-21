import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { CheckoutFingerprint } from "@rika/product/local-runner-registration"
import { BetterAuthUserId, OrganizationId, ThreadId } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as productPostgres } from "@rika/product-store/postgres-layer"
import type { Access, LocalExecutorHelloWire } from "@rika/remote-execution/protocol"
import { Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { testLayer as hostedModelRegistryTestLayer } from "../src/hosted-model-registry"
import { HostedProduct, layer as hostedProductLayer, type AuthenticatedPrincipal } from "../src/hosted-product"
import { testLayer as hostedRepositoriesTestLayer } from "../src/hosted-repositories"
import { LocalExecutor, layer as localExecutorLayer } from "../src/local-executor"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
const helloReadiness = {
  capabilities: { cells: true, checkpoints: false, pty: true },
  workspaceCapabilities: {
    environmentDigest: `sha256:${"0".repeat(64)}`,
    capturedAt: "2026-08-21T00:00:00.000Z",
    filesystem: { _tag: "Ready", detail: "filesystem ready" },
    typescriptKernel: { _tag: "Ready", detail: "TypeScript kernel ready" },
    git: { _tag: "Ready", detail: "Git ready" },
    process: { _tag: "Ready", detail: "process ready" },
    pty: { _tag: "Ready", detail: "PTY ready" },
    browser: { _tag: "Ready", detail: "browser ready" },
    services: { _tag: "Unavailable", reason: "repository services unavailable" },
    workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle ready" },
  },
  cursors: { command: 0, event: 0, pty: 0 },
} satisfies Omit<LocalExecutorHelloWire, "admissionId" | "ticket" | "processIncarnation">

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

const localConnection = (
  authenticated: AuthenticatedPrincipal,
  owner: ReturnType<typeof personal> | ReturnType<typeof organization>,
  checkoutFingerprint: string,
) =>
  Effect.gen(function* () {
    const product = yield* HostedProduct
    const fingerprint = CheckoutFingerprint.make(checkoutFingerprint)
    yield* product.registerLocalRunner({
      principal: authenticated,
      checkoutFingerprint: fingerprint,
      registration: {
        workspaceIdentity: `${checkoutFingerprint}-identity` as never,
        repository: { identity: `repository-${checkoutFingerprint}`, branch: "main" },
        kernel: { runtime: "bun", runtimeVersion: Bun.version, trustMode: "trusted-local" },
        capabilities: { cells: true, checkpoints: false, pty: false },
      },
    })
    const connection = yield* product.createConnection({
      principal: authenticated,
      owner,
      placement: "local",
      localRunnerTarget: {
        deviceId: authenticated.deviceId as never,
        checkoutFingerprint: fingerprint,
      },
    })
    return { ...connection, checkoutFingerprint: fingerprint }
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
          hostedRepositoriesTestLayer,
        )
        const context = yield* Layer.build(
          Layer.merge(
            hostedProductLayer({
              templateBuildId: "local-authority-live",
              providerScope: "local-authority-live",
              provision: () => Effect.void,
            }),
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
      const authority = yield* LocalExecutor
      const connection = yield* localConnection(owner, personal(owner.userId), "personal-workspace")
      const product = yield* HostedProduct
      const threadAuthority = yield* product.authorizeThread(owner, connection.threadId, "thread:view")
      expect(
        yield* product.threadExecutionContext(threadAuthority.ownerId, ThreadId.make(connection.threadId)),
      ).toMatchObject({
        repository: { identity: "repository-personal-workspace", branch: "main" },
        branch: "main",
        executor: { assignmentId: connection.threadId, kind: "local_device", generation: "1", lifecycle: "pending" },
      })
      expect((yield* query(pool, `SELECT count(*)::int AS count FROM member`)).rows).toEqual([{ count: 0 }])
      const admission = yield* authority.admit({
        threadId: connection.threadId,
        workspaceFingerprint: connection.checkoutFingerprint,
        principal: owner,
        executorUrl: "ws://executor.test/local",
      })
      const welcome = yield* authority.hello({
        admissionId: admission.admissionId,
        ticket: admission.ticket,
        processIncarnation: "personal-process",
        ...helloReadiness,
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
      const authority = yield* LocalExecutor
      const personalConnection = yield* localConnection(owner, personal(owner.userId), "personal-workspace")
      const organizationConnection = yield* localConnection(owner, organization("local-org"), "organization-workspace")
      const open = (connection: typeof personalConnection, label: string) =>
        Effect.gen(function* () {
          const admission = yield* authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: connection.checkoutFingerprint,
            principal: owner,
            executorUrl: "ws://executor.test/local",
          })
          return yield* authority.hello({
            admissionId: admission.admissionId,
            ticket: admission.ticket,
            processIncarnation: `${label}-process`,
            ...helloReadiness,
          })
        })
      const personalWelcome = yield* open(personalConnection, "personal")
      const organizationWelcome = yield* open(organizationConnection, "organization")
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
      const authority = yield* LocalExecutor
      const connection = yield* localConnection(owner, personal(owner.userId), "cross-owner")
      expect(
        yield* failureKind(
          authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: connection.checkoutFingerprint,
            principal: stranger,
            executorUrl: "ws://executor.test/local",
          }),
        ),
      ).toBe("fenced")
      expect(
        yield* failureKind(
          authority.admit({
            threadId: connection.threadId,
            workspaceFingerprint: connection.checkoutFingerprint,
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
