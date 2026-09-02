import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as HostedExecution from "@rika/execution"
import * as RemoteTools from "@rika/execution/remote-tools"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { identityMember, identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { BetterAuthUserId, DeviceId, OrganizationId, WorkspaceId } from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import {
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaHostedWorkspaceSeeds,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaThreadQueueState,
  rikaTurnAdmissionOutbox,
  rikaTurns,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { layer as productPostgres } from "@rika/product-store/layer"
import { HostedTurnWorkerStore, layer as hostedTurnWorkerStoreLayer } from "@rika/product-store/turn-worker-store"
import { asc, count as rowCount, eq, inArray, sql } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Clock, Config, Context, DateTime, Effect, FileSystem, Layer, Random, Redacted, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Runtime } from "generalist/runtime"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import {
  HostedProduct,
  HostedProductError,
  layer as hostedProductLayer,
  postgresTest,
  type AdmittedRun,
  type AuthenticatedPrincipal,
} from "../../../src/hosted/product"
import { testLayer as hostedModelRegistryTestLayer } from "../../../src/hosted/environment/model-registry"
import { unavailableLayer as hostedRepositoriesUnavailableLayer } from "../../../src/hosted/repositories"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
const decodeExecutionRoute = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionRouteSnapshot))
const decodePromptParts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(PromptPart)))
const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))

const principal = (userId: string): AuthenticatedPrincipal => ({
  userId,
  deviceId: `device-${userId}`,
  clientId: `client-${userId}`,
})

const personal = (userId: string) => ({
  _tag: "PersonalOwner" as const,
  userId: BetterAuthUserId.make(userId),
})
const organization = (organizationId: string) => ({
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make(organizationId),
})

const failureKind = <A>(effect: Effect.Effect<A, HostedProductError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.kind),
  )

const requireAdmitted = <E, R>(effect: Effect.Effect<AdmittedRun, E, R>) =>
  effect.pipe(
    Effect.flatMap((result) =>
      result._tag === "Admitted" ? Effect.succeed(result) : Effect.die("Prompt was cancelled unexpectedly"),
    ),
  )

const withDatabase = <A, E, R>(
  label: string,
  use: (database: NodePgDatabase) => Effect.Effect<A, E, R | HostedProduct>,
  promptAdmissionReadiness: Effect.Effect<boolean> = Effect.succeed(true),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_product_${label}_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
        const activePool = new Pool({ connectionString: url })
        pool = activePool
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
        const context = yield* Layer.build(
          postgresTest({
            database: { url: Redacted.make(url), maxConnections: 8 },
            templateBuildId: "hosted-product-live",
            providerScope: "hosted-product-live",
            promptAdmissionReadiness,
          }).pipe(Layer.provide(BunCrypto.layer)),
        )
        return yield* use(drizzle({ client: activePool })).pipe(Effect.provide(context))
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform)

const withAuthoritativeDatabase = <A, E>(
  label: string,
  use: (
    database: NodePgDatabase,
  ) => Effect.Effect<A, E, HostedProduct | HostedTurnWorkerStore | ExecutionGateway.Service | Runtime.Runtime>,
): Effect.Effect<A> =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_ledger_${label}_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
        const activePool = new Pool({ connectionString: url })
        pool = activePool
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
        yield* ExecutionPostgres.applySchema({ url, source: "hosted-thread-command-test" })
        const dataContext = yield* Layer.build(
          Layer.mergeAll(
            productPostgres({ url: Redacted.make(url), maxConnections: 8 }),
            AuthorizationPolicy.layer,
            BunCrypto.layer,
            hostedModelRegistryTestLayer,
            hostedRepositoriesUnavailableLayer,
          ),
        )
        const data = Layer.succeedContext(dataContext)
        const executionContext = yield* Layer.build(
          HostedExecution.layerHosted({
            tools: HostedExecution.remoteTools({
              tools: RemoteTools.layer({
                execute: () => RemoteTools.Unavailable.make({ message: "Test remote tools are unavailable" }),
                cancel: () => RemoteTools.Unavailable.make({ message: "Test remote tools are unavailable" }),
              }),
              admit: () => Effect.void,
            }),
            openAiAccountAccess: () => ({
              acquire: Effect.die("The atomic admission test does not execute the model"),
              refreshRejected: () => Effect.die("The atomic admission test does not refresh model credentials"),
            }),
            postgres: {
              url,
              source: "hosted-thread-command-test",
              maxConnections: 8,
              worker: {
                workerId: `hosted-thread-command-${suffix}`,
                concurrency: 1,
                leaseMillis: 30_000,
                fallbackIntervalMillis: 60_000,
                cancellationIntervalMillis: 60_000,
              },
            },
          }).pipe(Layer.provide(data)),
        )
        const productContext = yield* Layer.build(
          hostedProductLayer({
            orb: {
              templateBuildId: "hosted-thread-command-test",
              providerScope: "hosted-thread-command-test",
            },
            promptAdmissionReadiness: Effect.succeed(true),
          }).pipe(Layer.provide(Layer.succeedContext(Context.merge(dataContext, executionContext)))),
        )
        const turnWorkerContext = yield* Layer.build(hostedTurnWorkerStoreLayer.pipe(Layer.provide(data)))
        return yield* use(drizzle({ client: activePool })).pipe(
          Effect.provide(Context.merge(Context.merge(productContext, executionContext), turnWorkerContext)),
        )
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform, Effect.orDie)

export {
  expect,
  it,
  HostedExecution,
  ExecutionPostgres,
  identityMember,
  identityMigrations,
  identityOrganization,
  identityUser,
  runMigration,
  ExecutionGateway,
  PromptPart,
  ExecutionRouteSnapshot,
  AuthorizationPolicy,
  BetterAuthUserId,
  DeviceId,
  OrganizationId,
  WorkspaceId,
  CheckoutFingerprint,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaHostedWorkspaceSeeds,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaThreadQueueState,
  rikaTurnAdmissionOutbox,
  rikaTurns,
  rikaWorkspaces,
  productMigrations,
  productPostgres,
  HostedTurnWorkerStore,
  hostedTurnWorkerStoreLayer,
  asc,
  rowCount,
  eq,
  inArray,
  sql,
  drizzle,
  Clock,
  Config,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Random,
  Redacted,
  Ref,
  Runtime,
  Schema,
  TestClock,
  Pool,
  livePlatform,
  HostedProduct,
  hostedProductLayer,
  postgresTest,
  hostedModelRegistryTestLayer,
  hostedRepositoriesUnavailableLayer,
  live,
  principal,
  personal,
  organization,
  failureKind,
  requireAdmitted,
}
export type { AdmittedRun, AuthenticatedPrincipal, HostedProductError, NodePgDatabase }

export const hostedProductFixture = {
  decodeExecutionRoute,
  decodePromptParts,
  encodeStartTurn,
  withAuthoritativeDatabase,
  withDatabase,
}
