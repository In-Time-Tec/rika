import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Controller, ControllerError, type Interface as ControllerService } from "@rika/e2b-executor/controller"
import { identityMigrations, runMigration } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { BetterAuthUserId, OrganizationId, ThreadId } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as productPostgres } from "@rika/product-store/postgres-layer"
import type { Access, RunnerHelloWire } from "@rika/remote-execution/protocol"
import { Config, Effect, FileSystem, Layer, Random, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "./live-platform"
import { Executor, service as executorLayer } from "../src/executor"
import {
  HostedEnvironment,
  type HostedEnvironmentService,
  type ResolvedPhaseEnvironment,
} from "../src/hosted-environment"
import { testLayer as hostedModelRegistryTestLayer } from "../src/hosted-model-registry"
import { HostedProduct, layer as hostedProductLayer, type AuthenticatedPrincipal } from "../src/hosted-product"
import { unavailableLayer as hostedRepositoriesUnavailableLayer } from "../src/hosted-repositories"
import { HostedToolPolicy } from "../src/hosted-tool-policy"
import { RunnerExecutor, layer as runnerExecutorLayer } from "../src/runner-executor"
import { testToolPolicy } from "./hosted-tool-policy-fixture"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
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
} satisfies Omit<RunnerHelloWire, "admissionId" | "ticket" | "processIncarnation">
const unusedHostedEnvironment: HostedEnvironmentService = {
  put: () => Effect.die("unused"),
  revoke: () => Effect.die("unused"),
  putOrganizationPolicy: () => Effect.die("unused"),
  approveSource: () => Effect.die("unused"),
  revokeSourceApproval: () => Effect.die("unused"),
  putEgress: () => Effect.die("unused"),
  usePhase: () => Effect.die("unused"),
}

const availableHostedEnvironment: HostedEnvironmentService = {
  ...unusedHostedEnvironment,
  usePhase: (input, use) =>
    use({
      manifest: { phase: input.phase, digest: helloReadiness.workspaceCapabilities.environmentDigest, references: [] },
      values: {},
      egress: { phase: input.phase, allow: [] },
    } as unknown as ResolvedPhaseEnvironment),
}

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.tryPromise(() => pool.query(text, [...values]))

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
    yield* product.registerRunner({
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
      executorKind: "runner",
      runnerTarget: {
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
  use: (pool: Pool) => Effect.Effect<A, E, R | Executor | HostedProduct | RunnerExecutor>,
  services?: (pool: Pool) => {
    readonly controller?: ControllerService
    readonly environment?: HostedEnvironmentService
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_local_authority_${label}_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        const activePool = new Pool({ connectionString: url })
        pool = activePool
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFileString(migration.url.pathname),
          )
          yield* runMigration({ pool: activePool, id: migration.id, checksum: migration.checksum, sql })
        }
        const overrides = services?.(activePool)
        const base = Layer.mergeAll(
          productPostgres({ url: Redacted.make(url), maxConnections: 8 }),
          AuthorizationPolicy.layer,
          BunCrypto.layer,
          hostedModelRegistryTestLayer,
          hostedRepositoriesUnavailableLayer,
          Layer.succeed(
            Controller,
            overrides?.controller ?? ({ cleanupOrphans: Effect.succeed([]) } as unknown as ControllerService),
          ),
          Layer.succeed(HostedEnvironment, overrides?.environment ?? unusedHostedEnvironment),
          Layer.succeed(HostedToolPolicy, testToolPolicy),
        )
        const runnerExecutor = runnerExecutorLayer.pipe(Layer.provide(base))
        const context = yield* Layer.build(
          Layer.mergeAll(
            hostedProductLayer({
              orb: {
                templateBuildId: "local-authority-live",
                providerScope: "local-authority-live",
              },
              promptAdmissionReadiness: Effect.succeed(true),
            }).pipe(Layer.provide(base)),
            runnerExecutor,
            executorLayer.pipe(Layer.provide(runnerExecutor), Layer.provide(base)),
          ),
        )
        return yield* use(activePool).pipe(Effect.provide(context))
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform)

it.effect.skipIf(!live)("keeps real personal local authority active without organization membership", () =>
  isolated("personal", (pool) =>
    Effect.gen(function* () {
      const owner = principal("personal-user", "personal-client", "10000000-0000-4000-8000-000000000001")
      yield* seedPrincipal(pool, owner)
      const authority = yield* RunnerExecutor
      const connection = yield* localConnection(owner, personal(owner.userId), "personal-workspace")
      const product = yield* HostedProduct
      const threadAuthority = yield* product.authorizeThread(owner, connection.threadId, "thread:view")
      const context = yield* product.threadExecutionContext(threadAuthority.ownerId, ThreadId.make(connection.threadId))
      expect(context).toMatchObject({
        repository: { identity: "repository-personal-workspace", branch: "main" },
        branch: "main",
        executor: { kind: "runner", generation: "1", lifecycle: "pending" },
      })
      expect(context.executor.assignmentId).not.toBe(connection.threadId)
      expect((yield* query(pool, `SELECT count(*)::int AS count FROM member`)).rows).toEqual([{ count: 0 }])
      const admission = yield* authority.admit({
        threadId: connection.threadId,
        workspaceFingerprint: connection.checkoutFingerprint,
        principal: owner,
        executorUrl: "ws://executor.test/local",
      })
      const workspace = yield* query(pool, `SELECT workspace_id FROM rika_hosted_threads WHERE id = $1`, [
        connection.threadId,
      ])
      expect(admission.workspaceIdentity).toBe(workspace.rows[0].workspace_id)
      const welcome = yield* authority.hello({
        admissionId: admission.admissionId,
        ticket: admission.ticket,
        processIncarnation: "personal-process",
        ...helloReadiness,
      })
      const resume = yield* product.pollRunner({
        principal: owner,
        checkoutFingerprint: connection.checkoutFingerprint,
        supervisorId: "10000000-0000-4000-8000-000000000011",
        activeAssignmentIds: [],
      })
      expect(resume).toMatchObject({
        claimed: true,
        assignment: {
          assignmentId: admission.assignmentId,
          resume: true,
        },
      })
      expect(typeof resume.assignment?.leaseExpiresAt).toBe("number")
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [],
        }),
      ).toEqual({ claimed: false })
      yield* Effect.tryPromise(() =>
        pool.query(
          `UPDATE rika_hosted_runner_registrations SET supervisor_expires_at = clock_timestamp() - interval '1 second'`,
        ),
      )
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [admission.assignmentId],
        }),
      ).toEqual({ claimed: true })
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [],
        }),
      ).toMatchObject({
        claimed: true,
        assignment: { assignmentId: admission.assignmentId, resume: true },
      })
      const access = accessFrom(welcome)
      yield* authority.validateAccess(access)
      expect(yield* authority.workspaceIdentity(access)).toBe(workspace.rows[0].workspace_id)
      yield* Effect.tryPromise(() =>
        pool.query(
          `UPDATE rika_hosted_executor_assignments SET lease_expires_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [admission.assignmentId],
        ),
      )
      const reconnected = yield* authority.reconnect(access)
      expect(reconnected.leaseExpiresAt).toBeGreaterThan(welcome.leaseExpiresAt)
      yield* authority.heartbeat({
        version: 1,
        access: { ...access, leaseEpoch: reconnected.leaseEpoch },
        cursor: reconnected.cursor,
      })
      const admitted = yield* product.admitRun({
        principal: owner,
        threadId: connection.threadId,
        operationKey: "personal-turn",
        prompt: "personal prompt",
      })
      if (admitted._tag !== "Admitted") return yield* Effect.die("Runner prompt was cancelled unexpectedly")
      yield* Executor.pipe(
        Effect.flatMap((executor) =>
          executor.admitRun({
            threadId: connection.threadId,
            turnId: admitted.turnId,
            workspaceId: workspace.rows[0].workspace_id,
          }),
        ),
      )
      expect(
        (yield* query(pool, `SELECT consumed_at IS NOT NULL AS consumed FROM rika_hosted_runner_admissions`)).rows,
      ).toEqual([{ consumed: true }])
      expect(
        (yield* query(
          pool,
          `SELECT required_capabilities FROM rika_hosted_workspace_capability_admissions WHERE turn_id = $1`,
          [admitted.turnId],
        )).rows,
      ).toEqual([
        {
          required_capabilities: ["filesystem", "typescriptKernel", "git", "process", "workspaceLifecycle"],
        },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("leaves a blank Orb pending and provisions its first capability admission once", () => {
  let provisionCount = 0
  return isolated(
    "orb-provisioning-owner",
    (pool) =>
      Effect.gen(function* () {
        const owner = principal("orb-user", "orb-client", "15000000-0000-4000-8000-000000000001")
        yield* seedPrincipal(pool, owner)
        const product = yield* HostedProduct
        const connection = yield* product.createConnection({
          principal: owner,
          owner: personal(owner.userId),
          executorKind: "orb",
        })
        expect(provisionCount).toBe(0)
        const admitted = yield* product.admitRun({
          principal: owner,
          threadId: connection.threadId,
          operationKey: "orb-turn",
          prompt: "run in the Orb",
        })
        if (admitted._tag !== "Admitted") return yield* Effect.die("Orb prompt was cancelled unexpectedly")
        const assignment = (yield* query(
          pool,
          `SELECT id, workspace_id FROM rika_hosted_executor_assignments WHERE thread_id = $1`,
          [connection.threadId],
        )).rows[0]
        const executor = yield* Executor
        yield* executor.admitRun({
          threadId: connection.threadId,
          turnId: admitted.turnId,
          workspaceId: assignment.workspace_id,
        })
        expect(provisionCount).toBe(1)
        expect(
          (yield* query(
            pool,
            `SELECT count(*)::int AS count FROM rika_hosted_workspace_capability_admissions
               WHERE thread_id = $1 AND turn_id = $2`,
            [connection.threadId, admitted.turnId],
          )).rows,
        ).toEqual([{ count: 1 }])
      }),
    (pool) => ({
      environment: availableHostedEnvironment,
      controller: {
        cleanupOrphans: Effect.succeed([]),
        provision: (assignmentId: string) =>
          Effect.gen(function* () {
            provisionCount += 1
            const rows = yield* Effect.tryPromise({
              try: () =>
                pool.query(
                  `UPDATE rika_hosted_executor_assignments SET
                 revision = revision + 1, last_lease_epoch = 1, lifecycle = 'active',
                 provider_instance_id = 'orb-sandbox', executor_instance_id = 'orb-executor',
                 process_incarnation = 'orb-process', session_digest = 'orb-session-digest',
                 lease_epoch = 1, lease_expires_at = clock_timestamp() + interval '1 minute',
                 capability_generation = generation, capability_snapshot = $2::jsonb,
                 last_active_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE id = $1
               RETURNING thread_id, generation`,
                  [assignmentId, encodeJson(helloReadiness.workspaceCapabilities)],
                ),
              catch: (error) =>
                ControllerError.make({
                  kind: "repository",
                  message: `Could not activate fake Orb assignment: ${String(error)}`,
                }),
            })
            const row = rows.rows[0]
            return {
              assignmentId,
              threadId: row.thread_id,
              generation: Number(row.generation),
              templateBuildId: "local-authority-live",
              sandboxId: "orb-sandbox",
              state: "running" as const,
              cursor: { sequence: 0, value: "" } as never,
            }
          }),
      } as unknown as ControllerService,
    }),
  )
})

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
      const authority = yield* RunnerExecutor
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
      const authority = yield* RunnerExecutor
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
      expect((yield* query(pool, `SELECT count(*)::int AS count FROM rika_hosted_runner_admissions`)).rows).toEqual([
        { count: 0 },
      ])
    }),
  ),
)
