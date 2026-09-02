import { expect } from "@effect/vitest"

import * as BunServices from "@effect/platform-bun/BunServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import { AssignmentRevision, type WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import type { Version } from "@rika/product/executor-assignments"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  OrganizationId,
  OwnerId,
  ProjectId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { sql as drizzleSql } from "drizzle-orm"
import { EffectLogger } from "drizzle-orm/effect-core"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Config, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { runMigration } from "../../../identity/src/database/postgres"
import * as schema from "../../src/database/schema/product"
import { migrations } from "../../src/hosted/migrations"

export const databaseUrl = Effect.runSync(
  Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")),
)
export const live = databaseUrl !== ""
export const readFileString = (url: URL) =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((context) =>
        Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(fileURLToPath(url))),
          context,
        ),
      ),
    ),
  )
export const at = (second: number) => Timestamp.make(`2099-01-01T00:00:${String(second).padStart(2, "0")}.000Z`)
export const capabilities: WorkspaceCapabilitySnapshot = {
  environmentDigest: `sha256:${"a".repeat(64)}`,
  capturedAt: at(0),
  filesystem: { _tag: "Ready", detail: "workspace filesystem" },
  nativeTools: { _tag: "Ready", detail: "native tools" },
  git: { _tag: "Ready", detail: "git" },
  process: { _tag: "Ready", detail: "process execution" },
  pty: { _tag: "Ready", detail: "PTY" },
  browser: { _tag: "Unavailable", reason: "browser not installed" },
  services: { _tag: "Unavailable", reason: "repository services unavailable" },
  workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle" },
}
export const unknownEvent = {
  _tag: "NativeToolResult",
  operationKey: "operation-recovered",
  response: {
    _tag: "DomainFailure",
    failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
  },
}

export const ids = {
  client: ClientId.make("client-recovery"),
  device: DeviceId.make("device-recovery"),
  executor: ExecutorInstanceId.make("executor-recovery"),
  member: BetterAuthMemberId.make("member-recovery"),
  organization: OrganizationId.make("organization-recovery"),
  owner: OwnerId.make("owner-recovery"),
  project: ProjectId.make("project-recovery"),
  thread: ThreadId.make("thread-recovery"),
  user: BetterAuthUserId.make("user-recovery"),
  workspace: WorkspaceId.make("workspace-recovery"),
  assignment: ExecutorAssignmentId.make("assignment-recovery"),
}

export const version = (assignment: {
  readonly id: string
  readonly generation: string
  readonly revision: string
}): Version => ({
  assignmentId: ExecutorAssignmentId.make(assignment.id),
  generation: FencingGeneration.make(assignment.generation),
  revision: AssignmentRevision.make(assignment.revision),
})

export const apply = (
  pool: Pool,
  selected: ReadonlyArray<(typeof migrations)[number] | (typeof identityMigrations)[number]>,
) =>
  Effect.gen(function* () {
    for (const migration of selected) {
      const sql = yield* readFileString(migration.url)
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(true)
    }
  })

export const isolated = <A, E, R>(
  run: (input: {
    readonly url: string
    readonly pool: Pool
    readonly database: NodePgDatabase
    readonly effectDatabase: PgDrizzle.EffectPgDatabase
    readonly countingEffectDatabase: PgDrizzle.EffectPgDatabase
    readonly statements: Array<string>
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_local_recovery_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const databaseClient = drizzle({ client: pool })
      const context = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
      const effectDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(context))
      const statements: Array<string> = []
      const defaults = yield* Layer.build(PgDrizzle.DefaultServices)
      const countingEffectDatabase = yield* PgDrizzle.make().pipe(
        Effect.provideService(EffectLogger, EffectLogger.fromDrizzle({ logQuery: (query) => statements.push(query) })),
        Effect.provideContext(defaults),
        Effect.provideContext(context),
      )
      try {
        return yield* run({ url, pool, database: databaseClient, effectDatabase, countingEffectDatabase, statements })
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  )

export const seedIdentity = (database: NodePgDatabase) =>
  Effect.gen(function* () {
    const now = drizzleSql`transaction_timestamp()`
    yield* Effect.tryPromise(() =>
      database.insert(identityUser).values({
        id: "user-recovery",
        name: "Recovery",
        email: "recovery@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      database.insert(identityOrganization).values({
        id: "organization-recovery",
        name: "Recovery",
        slug: "recovery",
        createdAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      database.insert(identityMember).values({
        id: "member-recovery",
        organizationId: "organization-recovery",
        userId: "user-recovery",
        role: "owner",
        createdAt: now,
      }),
    )
  })

export const seedRecoveryAggregate = (database: PgDrizzle.EffectPgDatabase) =>
  database.transaction((tx) =>
    Effect.gen(function* () {
      const now = drizzleSql`transaction_timestamp()`
      yield* tx
        .insert(schema.rikaHostedOwners)
        .values({ id: ids.owner, kind: "organization", organizationId: ids.organization })
      yield* tx.insert(schema.rikaHostedOwnerCounters).values({ ownerId: ids.owner })
      yield* tx.insert(schema.rikaHostedProjects).values({
        id: ids.project,
        ownerId: ids.owner,
        name: "Recovery",
        createdByUserId: ids.user,
        createdAt: now,
        updatedAt: now,
      })
      yield* tx.insert(schema.rikaHostedWorkspaces).values({
        id: ids.workspace,
        ownerId: ids.owner,
        projectId: ids.project,
        createdByUserId: ids.user,
        executorKind: "runner",
        inheritProjectGrants: false,
        createdAt: now,
      })
      yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: ids.owner, path: ids.workspace, createdAt: 1 })
      yield* tx.insert(schema.rikaHostedThreads).values({
        id: ids.thread,
        ownerId: ids.owner,
        projectId: ids.project,
        workspaceId: ids.workspace,
        createdByUserId: ids.user,
        executorKind: "runner",
        inheritProjectGrants: false,
        createdAt: now,
      })
      yield* tx.insert(schema.rikaThreads).values({
        id: ids.thread,
        ownerId: ids.owner,
        workspace: ids.workspace,
        title: "Recovery",
        createdAt: 1,
        updatedAt: 1,
      })
    }),
  )
