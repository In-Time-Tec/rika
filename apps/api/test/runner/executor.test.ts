import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Controller, ControllerError, type Interface as ControllerService } from "@rika/e2b-executor/controller"
import {
  cliRegistration,
  identityMember,
  identityMigrations,
  oauthClient,
  identityOrganization,
  identityUser,
  runMigration,
} from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { BetterAuthUserId, DeviceId, OrganizationId, ThreadId, WorkspaceId } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorAssignments,
  rikaHostedRunnerAdmissions,
  rikaHostedRunnerRegistrations,
  rikaHostedThreads,
  rikaHostedWorkspaceCapabilityAdmissions,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as productPostgres } from "@rika/product-store/layer"
import { emptyCursor, type Access, type RunnerHelloWire } from "@rika/remote-execution/protocol"
import { and, count, eq, sql } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Config, DateTime, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "../support/live-platform"
import { Executor, service as executorLayer } from "../../src/executor/service"
import {
  HostedEnvironment,
  type HostedEnvironmentService,
  type ResolvedPhaseEnvironment,
} from "../../src/hosted/environment/runtime"
import { testLayer as hostedModelRegistryTestLayer } from "../../src/hosted/environment/model-registry"
import { HostedProduct, layer as hostedProductLayer, type AuthenticatedPrincipal } from "../../src/hosted/product"
import { unavailableLayer as hostedRepositoriesUnavailableLayer } from "../../src/hosted/repositories"
import { HostedToolPolicy } from "../../src/hosted/execution/tool-policy"
import { RunnerExecutor, layer as runnerExecutorLayer } from "../../src/runner/executor"
import { testToolPolicy } from "../hosted/execution/tool-policy.fixture"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
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
    services: {
      _tag: "Unavailable",
      reason: "repository services unavailable",
    },
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
const unusedController: ControllerService = {
  provision: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  kill: () => Effect.die("unused"),
  portal: () => Effect.die("unused"),
  hello: () => Effect.die("unused"),
  reconnect: () => Effect.die("unused"),
  validateAccess: () => Effect.die("unused"),
  heartbeat: () => Effect.die("unused"),
  checkpoint: () => Effect.die("unused"),
  credential: () => Effect.die("unused"),
  revokeCredential: () => Effect.die("unused"),
  workspace: () => Effect.die("unused"),
  ready: () => Effect.die("unused"),
  loadSetupCache: () => Effect.die("unused"),
  storeSetupCache: () => Effect.die("unused"),
  activatePhase: () => Effect.die("unused"),
  cleanupOrphans: Effect.succeed([]),
}

const availableHostedEnvironment: HostedEnvironmentService = {
  ...unusedHostedEnvironment,
  usePhase: (input, use) =>
    use({
      manifest: {
        phase: input.phase,
        digest: helloReadiness.workspaceCapabilities.environmentDigest,
        references: [],
      },
      values: {},
      egress: { phase: input.phase, allow: [] },
    } satisfies ResolvedPhaseEnvironment),
}

const personal = (userId: string) => ({
  _tag: "PersonalOwner" as const,
  userId: BetterAuthUserId.make(userId),
})
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

const seedPrincipal = (databaseClient: NodePgDatabase, input: AuthenticatedPrincipal) =>
  Effect.gen(function* () {
    const dpopJkt = input.dpopJkt
    if (dpopJkt === undefined) return yield* Effect.die("Seeded principal is missing a DPoP thumbprint")
    const now = yield* DateTime.nowAsDate
    yield* Effect.tryPromise(() =>
      databaseClient
        .insert(identityUser)
        .values({
          id: input.userId,
          name: input.userId,
          email: `${input.userId}@example.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: identityUser.id }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(oauthClient).values({
        id: input.clientId,
        clientId: input.clientId,
        userId: input.userId,
        redirectUris: [],
        createdAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(cliRegistration).values({
        clientId: input.clientId,
        deviceId: input.deviceId,
        publicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          y: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        jwkThumbprint: dpopJkt,
        userId: input.userId,
      }),
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
        workspaceIdentity: WorkspaceId.make(`${checkoutFingerprint}-identity`),
        repository: {
          identity: `repository-${checkoutFingerprint}`,
          branch: "main",
        },
        kernel: {
          runtime: "bun",
          runtimeVersion: Bun.version,
          trustMode: "trusted-local",
        },
        capabilities: { cells: true, checkpoints: false, pty: false },
      },
    })
    const connection = yield* product.createConnection({
      principal: authenticated,
      owner,
      executorKind: "runner",
      runnerTarget: {
        deviceId: DeviceId.make(authenticated.deviceId),
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
  use: (databaseClient: NodePgDatabase) => Effect.Effect<A, E, R | Executor | HostedProduct | RunnerExecutor>,
  services?: (databaseClient: NodePgDatabase) => {
    readonly controller?: ControllerService
    readonly environment?: HostedEnvironmentService
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_local_authority_${label}_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        const activePool = new Pool({ connectionString: url })
        pool = activePool
        const databaseClient = drizzle({ client: activePool })
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const migrationSql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFileString(migration.url.pathname),
          )
          yield* runMigration({
            pool: activePool,
            id: migration.id,
            checksum: migration.checksum,
            sql: migrationSql,
          })
        }
        const overrides = services?.(databaseClient)
        const base = Layer.mergeAll(
          productPostgres({ url: Redacted.make(url), maxConnections: 8 }),
          AuthorizationPolicy.layer,
          BunCrypto.layer,
          hostedModelRegistryTestLayer,
          hostedRepositoriesUnavailableLayer,
          Layer.succeed(Controller, overrides?.controller ?? unusedController),
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
        return yield* use(databaseClient).pipe(Effect.provide(context))
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.orDie(Effect.tryPromise(() => cleanupPool.end()))
        yield* Effect.orDie(Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)))
        yield* Effect.orDie(Effect.tryPromise(() => admin.end()))
      }
    }),
  ).pipe(livePlatform)

it.effect.skipIf(!live)("keeps real personal local authority active without organization membership", () =>
  isolated("personal", (databaseClient) =>
    Effect.gen(function* () {
      const owner = principal("personal-user", "personal-client", "10000000-0000-4000-8000-000000000001")
      yield* seedPrincipal(databaseClient, owner)
      const authority = yield* RunnerExecutor
      const connection = yield* localConnection(owner, personal(owner.userId), "personal-workspace")
      const product = yield* HostedProduct
      const threadAuthority = yield* product.authorizeThread(owner, connection.threadId, "thread:view")
      const context = yield* product.threadExecutionContext(threadAuthority.ownerId, ThreadId.make(connection.threadId))
      expect(context).toMatchObject({
        repository: {
          identity: "repository-personal-workspace",
          branch: "main",
        },
        branch: "main",
        executor: { kind: "runner", generation: "1", lifecycle: "pending" },
      })
      expect(context.executor.assignmentId).not.toBe(connection.threadId)
      expect(yield* Effect.tryPromise(() => databaseClient.select({ count: count() }).from(identityMember))).toEqual([
        { count: 0 },
      ])
      const admission = yield* authority.admit({
        threadId: connection.threadId,
        workspaceFingerprint: connection.checkoutFingerprint,
        principal: owner,
        executorUrl: "ws://executor.test/local",
      })
      const workspace = yield* Effect.tryPromise(() =>
        databaseClient
          .select({ workspaceId: rikaHostedThreads.workspaceId })
          .from(rikaHostedThreads)
          .where(eq(rikaHostedThreads.id, connection.threadId)),
      )
      const workspaceRow = workspace[0]
      if (workspaceRow === undefined) return yield* Effect.die("Expected the personal thread workspace to exist")
      expect(admission.workspaceIdentity).toBe(workspaceRow.workspaceId)
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
      expect(Number.isFinite(resume.assignment?.leaseExpiresAt)).toBe(true)
      expect(
        yield* product.pollRunner({
          principal: owner,
          checkoutFingerprint: connection.checkoutFingerprint,
          supervisorId: "10000000-0000-4000-8000-000000000012",
          activeAssignmentIds: [],
        }),
      ).toEqual({ claimed: false })
      const expiredSupervisorAt = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { seconds: 1 }))
      yield* Effect.tryPromise(() =>
        databaseClient.update(rikaHostedRunnerRegistrations).set({ supervisorExpiresAt: expiredSupervisorAt }),
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
      expect(yield* authority.workspaceIdentity(access)).toBe(workspaceRow.workspaceId)
      const expiredLeaseAt = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { seconds: 1 }))
      yield* Effect.tryPromise(() =>
        databaseClient
          .update(rikaHostedExecutorAssignments)
          .set({ leaseExpiresAt: expiredLeaseAt })
          .where(eq(rikaHostedExecutorAssignments.id, admission.assignmentId)),
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
            workspaceId: workspaceRow.workspaceId,
          }),
        ),
      )
      expect(
        (yield* Effect.tryPromise(() =>
          databaseClient.select({ consumedAt: rikaHostedRunnerAdmissions.consumedAt }).from(rikaHostedRunnerAdmissions),
        )).map((row) => ({ consumed: row.consumedAt !== null })),
      ).toEqual([{ consumed: true }])
      expect(
        yield* Effect.tryPromise(() =>
          databaseClient
            .select({ required_capabilities: rikaHostedWorkspaceCapabilityAdmissions.requiredCapabilities })
            .from(rikaHostedWorkspaceCapabilityAdmissions)
            .where(eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, admitted.turnId)),
        ),
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
    (databaseClient) =>
      Effect.gen(function* () {
        const owner = principal("orb-user", "orb-client", "15000000-0000-4000-8000-000000000001")
        yield* seedPrincipal(databaseClient, owner)
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
        const assignment = (yield* Effect.tryPromise(() =>
          databaseClient
            .select({ id: rikaHostedExecutorAssignments.id, workspaceId: rikaHostedExecutorAssignments.workspaceId })
            .from(rikaHostedExecutorAssignments)
            .where(eq(rikaHostedExecutorAssignments.threadId, connection.threadId)),
        ))[0]
        if (assignment === undefined) return yield* Effect.die("Expected the Orb executor assignment to exist")
        const executor = yield* Executor
        yield* executor.admitRun({
          threadId: connection.threadId,
          turnId: admitted.turnId,
          workspaceId: assignment.workspaceId,
        })
        expect(provisionCount).toBe(1)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ count: count() })
              .from(rikaHostedWorkspaceCapabilityAdmissions)
              .where(
                and(
                  eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, connection.threadId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, admitted.turnId),
                ),
              ),
          ),
        ).toEqual([{ count: 1 }])
      }),
    (databaseClient) => ({
      environment: availableHostedEnvironment,
      controller: {
        ...unusedController,
        cleanupOrphans: Effect.succeed([]),
        provision: (assignmentId: string) =>
          Effect.gen(function* () {
            provisionCount += 1
            const activatedAt = yield* DateTime.now
            const activatedAtDate = DateTime.toDate(activatedAt)
            const rows = yield* Effect.tryPromise({
              try: () =>
                databaseClient
                  .update(rikaHostedExecutorAssignments)
                  .set({
                    revision: sql`${rikaHostedExecutorAssignments.revision} + 1`,
                    lastLeaseEpoch: 1,
                    lifecycle: "active",
                    providerInstanceId: "orb-sandbox",
                    executorInstanceId: "orb-executor",
                    processIncarnation: "orb-process",
                    sessionDigest: "orb-session-digest",
                    leaseEpoch: 1,
                    leaseExpiresAt: DateTime.toDate(DateTime.add(activatedAt, { minutes: 1 })),
                    capabilityGeneration: sql`${rikaHostedExecutorAssignments.generation}`,
                    capabilitySnapshot: helloReadiness.workspaceCapabilities,
                    lastActiveAt: activatedAtDate,
                    updatedAt: activatedAtDate,
                  })
                  .where(eq(rikaHostedExecutorAssignments.id, assignmentId))
                  .returning({
                    threadId: rikaHostedExecutorAssignments.threadId,
                    generation: rikaHostedExecutorAssignments.generation,
                  }),
              catch: (error) =>
                ControllerError.make({
                  kind: "repository",
                  message: `Could not activate fake Orb assignment: ${String(error)}`,
                }),
            })
            const row = rows[0]
            if (row === undefined) return yield* Effect.die(`Expected Orb assignment ${assignmentId} to be activated`)
            return {
              assignmentId,
              threadId: row.threadId,
              generation: row.generation,
              templateBuildId: "local-authority-live",
              sandboxId: "orb-sandbox",
              state: "running" as const,
              cursor: emptyCursor,
            }
          }),
      },
    }),
  )
})

it.effect.skipIf(!live)("fences organization access immediately while preserving a personal session", () =>
  isolated("membership", (databaseClient) =>
    Effect.gen(function* () {
      const owner = principal("shared-user", "shared-client", "20000000-0000-4000-8000-000000000002")
      yield* seedPrincipal(databaseClient, owner)
      const now = yield* DateTime.nowAsDate
      yield* Effect.tryPromise(() =>
        databaseClient
          .insert(identityOrganization)
          .values({ id: "local-org", name: "Local org", slug: "local-org", createdAt: now }),
      )
      yield* Effect.tryPromise(() =>
        databaseClient.insert(identityMember).values({
          id: "local-member",
          organizationId: "local-org",
          userId: owner.userId,
          role: "member",
          createdAt: now,
        }),
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
      yield* Effect.tryPromise(() => databaseClient.delete(identityMember).where(eq(identityMember.id, "local-member")))
      for (const operation of [
        authority.validateAccess(organizationAccess),
        authority.reconnect(organizationAccess),
        authority.heartbeat({
          version: 1,
          access: organizationAccess,
          cursor: organizationWelcome.cursor,
        }),
      ]) {
        expect(["authentication", "fenced"]).toContain(yield* failureKind(operation))
      }
      yield* authority.validateAccess(personalAccess)
      const personalReconnect = yield* authority.reconnect(personalAccess)
      yield* authority.heartbeat({
        version: 1,
        access: {
          ...personalAccess,
          leaseEpoch: personalReconnect.leaseEpoch,
        },
        cursor: personalReconnect.cursor,
      })
    }),
  ),
)

it.effect.skipIf(!live)("rejects cross-owner and cross-device admissions before issuing usable tickets", () =>
  isolated("cross_binding", (databaseClient) =>
    Effect.gen(function* () {
      const owner = principal("owner-user", "owner-client", "30000000-0000-4000-8000-000000000003")
      const stranger = principal("stranger-user", "stranger-client", "40000000-0000-4000-8000-000000000004")
      const otherDevice = principal("owner-user", "other-client", "50000000-0000-4000-8000-000000000005")
      yield* seedPrincipal(databaseClient, owner)
      yield* seedPrincipal(databaseClient, stranger)
      yield* seedPrincipal(databaseClient, otherDevice)
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
      expect(
        yield* Effect.tryPromise(() => databaseClient.select({ count: count() }).from(rikaHostedRunnerAdmissions)),
      ).toEqual([{ count: 0 }])
    }),
  ),
)
