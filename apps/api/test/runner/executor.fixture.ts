import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Controller, type Interface as ControllerService } from "@rika/e2b-executor/controller"
import { cliRegistration, identityMigrations, oauthClient, identityUser, runMigration } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { BetterAuthUserId, DeviceId, OrganizationId, WorkspaceId } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as productPostgres } from "@rika/product-store/layer"
import type { Access, RunnerHelloWire } from "@rika/remote-execution/protocol"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Clock, Config, DateTime, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { TestClock } from "effect/testing"
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
      yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
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
          ExecutionGateway.layerTest(),
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

export const executorFixture = {
  databaseUrl,
  live,
  helloReadiness,
  unusedHostedEnvironment,
  unusedController,
  availableHostedEnvironment,
  personal,
  organization,
  principal,
  seedPrincipal,
  localConnection,
  accessFrom,
  failureKind,
  isolated,
}
