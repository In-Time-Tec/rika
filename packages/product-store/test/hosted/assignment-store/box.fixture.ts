import { DateTime, Effect, Layer, Option, Redacted } from "effect"
import { sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { identityMigrations } from "../../../../identity/src/database/migrations"
import { clientLayer } from "../../../src/database/postgres"
import { rikaBoxAssignmentBindings } from "../../../src/database/schema/box/assignments"
import * as schema from "../../../src/database/schema/product"
import {
  type BoxAssignmentRepository,
  makeBoxAssignmentRepository,
  type OrbExecutorPlacementPolicy,
} from "../../../src/hosted/assignment-store/box"
import { encodeBoxAssignmentIdentity } from "../../../src/hosted/assignment-store/box-assignment-identity"
import { migrations } from "../../../src/hosted/migrations"
import type { ProductRepositoryService } from "../../../src/hosted/product/contract"
import { threadOperations } from "../../../src/hosted/product/thread-operations"
import { apply, isolated, seedIdentity } from "../assignments.support"

export const placement: OrbExecutorPlacementPolicy = {
  _tag: "OrbPlacement",
  templateBuildId: "box-template-1",
  providerScope: "box-provider-1",
  executorPolicy: { buildId: "executor-build-1", protocolVersion: 1 },
  lineageId: "box-lineage-1",
}

export const checkout = {
  ownerId: "box-owner",
  projectId: "box-project",
  repositoryId: "box-repository",
  installationId: "box-installation",
  owner: "in-time-tec",
  name: "rika",
  ref: "refs/heads/main",
  commitSha: "a".repeat(40),
  private: true,
  gitIdentity: { name: "Rika", email: "rika@example.test" },
}

export const workspaceSeed = {
  id: "box-seed",
  sourceRepository: { owner: "in-time-tec", name: "rika" },
  objectKey: "workspace-seeds/box-seed.tar.zst",
  contentDigest: `sha256:${"b".repeat(64)}`,
  sizeBytes: 1024,
  archiveDigest: `sha256:${"c".repeat(64)}`,
  archiveSizeBytes: 768,
  encryption: "aes-256-gcm" as const,
}

export const fencedId = (rawAssignmentId: string, generation: number) =>
  Option.getOrThrow(encodeBoxAssignmentIdentity({ rawAssignmentId, generation }))

const seedAuthority = (database: PgDrizzle.EffectPgDatabase) =>
  database.transaction((tx) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))
      yield* tx.insert(schema.rikaHostedOwners).values({
        id: "box-owner",
        kind: "organization",
        organizationId: "organization-recovery",
      })
      yield* tx.insert(schema.rikaHostedProjects).values({
        id: "box-project",
        ownerId: "box-owner",
        name: "Box Project",
        createdByUserId: "user-recovery",
        createdAt,
        updatedAt: createdAt,
      })
      yield* tx.insert(schema.rikaHostedProjectRepositories).values({
        projectId: "box-project",
        ownerId: "box-owner",
        repositoryId: "box-repository",
        installationId: "box-installation",
        installationAccountId: "box-account",
        installationAccountLogin: "in-time-tec",
        installationAccountType: "Organization",
        repositoryOwner: "in-time-tec",
        repositoryName: "rika",
        defaultRef: "refs/heads/main",
        private: true,
        createdAt,
        updatedAt: createdAt,
      })
    }),
  )

export const seedAssignment = (
  database: PgDrizzle.EffectPgDatabase,
  input: {
    readonly suffix: string
    readonly lifecycle?: "pending" | "provisioning" | "paused" | "terminated"
    readonly providerInstanceId?: string | null
    readonly selectedPlacement?: OrbExecutorPlacementPolicy
    readonly checkout?: typeof checkout | null
    readonly workspaceSeed?: typeof workspaceSeed | null
  },
) =>
  database.transaction((tx) =>
    Effect.gen(function* () {
      const workspaceId = `box-workspace-${input.suffix}`
      const threadId = `box-thread-${input.suffix}`
      const assignmentId = `box-assignment-${input.suffix}`
      const lifecycle = input.lifecycle ?? "pending"
      const createdAt = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))
      yield* tx.insert(schema.rikaHostedWorkspaces).values({
        id: workspaceId,
        ownerId: "box-owner",
        projectId: input.checkout === null || input.checkout === undefined ? null : "box-project",
        createdByUserId: "user-recovery",
        executorKind: "orb",
        inheritProjectGrants: false,
        createdAt,
      })
      yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: "box-owner", path: workspaceId, createdAt: 1 })
      yield* tx.insert(schema.rikaThreads).values({
        id: threadId,
        ownerId: "box-owner",
        workspace: workspaceId,
        title: `Box ${input.suffix}`,
        createdAt: 1,
        updatedAt: 1,
      })
      yield* tx.insert(schema.rikaHostedThreads).values({
        id: threadId,
        ownerId: "box-owner",
        projectId: input.checkout === null || input.checkout === undefined ? null : "box-project",
        workspaceId,
        createdByUserId: "user-recovery",
        executorKind: "orb",
        inheritProjectGrants: false,
        createdAt,
      })
      yield* tx.insert(schema.rikaHostedExecutorAssignments).values({
        id: assignmentId,
        ownerId: "box-owner",
        threadId,
        workspaceId,
        executorKind: "orb",
        placement: input.selectedPlacement ?? placement,
        checkout: input.checkout ?? null,
        workspaceSeed: input.workspaceSeed ?? null,
        generation: 1,
        revision: 0,
        lastLeaseEpoch: 0,
        lifecycle,
        providerInstanceId: input.providerInstanceId ?? null,
        bootstrapDigest: null,
        bootstrapExpiresAt: null,
      })
      return {
        rawAssignmentId: assignmentId,
        assignmentId: fencedId(assignmentId, 1),
        threadId,
        workspaceId,
      }
    }),
  )

export const seedRunnerAssignment = (database: PgDrizzle.EffectPgDatabase, suffix: string) =>
  database.transaction((tx) =>
    Effect.gen(function* () {
      const workspaceId = `runner-workspace-${suffix}`
      const threadId = `runner-thread-${suffix}`
      const assignmentId = `runner-assignment-${suffix}`
      const createdAt = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))
      yield* tx.insert(schema.rikaHostedWorkspaces).values({
        id: workspaceId,
        ownerId: "box-owner",
        createdByUserId: "user-recovery",
        executorKind: "runner",
        inheritProjectGrants: false,
        createdAt,
      })
      yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: "box-owner", path: workspaceId, createdAt: 1 })
      yield* tx.insert(schema.rikaThreads).values({
        id: threadId,
        ownerId: "box-owner",
        workspace: workspaceId,
        title: `Runner ${suffix}`,
        createdAt: 1,
        updatedAt: 1,
      })
      yield* tx.insert(schema.rikaHostedThreads).values({
        id: threadId,
        ownerId: "box-owner",
        workspaceId,
        createdByUserId: "user-recovery",
        executorKind: "runner",
        inheritProjectGrants: false,
        createdAt,
      })
      yield* tx.insert(schema.rikaHostedExecutorAssignments).values({
        id: assignmentId,
        ownerId: "box-owner",
        threadId,
        workspaceId,
        executorKind: "runner",
        placement: {
          _tag: "RunnerPlacement",
          deviceId: `runner-device-${suffix}`,
          checkoutFingerprint: `runner-checkout-${suffix}`,
          requestingDeviceId: `runner-device-${suffix}`,
        },
        generation: 1,
        revision: 0,
        lastLeaseEpoch: 0,
        lifecycle: "pending",
      })
      return { assignmentId, threadId, workspaceId }
    }),
  )

export const fixture = <A, E>(
  run: (input: {
    readonly repository: BoxAssignmentRepository
    readonly database: PgDrizzle.EffectPgDatabase
    readonly product: Pick<ProductRepositoryService, "threadExecutionContext">
  }) => Effect.Effect<A, E>,
) =>
  isolated(({ url, pool, database, effectDatabase }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      yield* seedIdentity(database)
      yield* seedAuthority(effectDatabase)
      const context = yield* Layer.build(clientLayer({ url: Redacted.make(url), maxConnections: 4 }))
      const repository = yield* makeBoxAssignmentRepository.pipe(Effect.provideContext(context))
      const product = yield* threadOperations.pipe(Effect.provideContext(context))
      return yield* run({ repository, database: effectDatabase, product })
    }),
  )

export const readStored = (database: PgDrizzle.EffectPgDatabase, assignmentId: string) =>
  database
    .select({
      id: schema.rikaHostedExecutorAssignments.id,
      ownerId: schema.rikaHostedExecutorAssignments.ownerId,
      threadId: schema.rikaHostedExecutorAssignments.threadId,
      workspaceId: schema.rikaHostedExecutorAssignments.workspaceId,
      generation: schema.rikaHostedExecutorAssignments.generation,
      revision: schema.rikaHostedExecutorAssignments.revision,
      lifecycle: schema.rikaHostedExecutorAssignments.lifecycle,
      placement: schema.rikaHostedExecutorAssignments.placement,
      checkout: schema.rikaHostedExecutorAssignments.checkout,
      workspaceSeed: schema.rikaHostedExecutorAssignments.workspaceSeed,
      providerInstanceId: schema.rikaHostedExecutorAssignments.providerInstanceId,
      bootstrapDigest: schema.rikaHostedExecutorAssignments.bootstrapDigest,
      bootstrapExpiresAt: schema.rikaHostedExecutorAssignments.bootstrapExpiresAt,
      executorInstanceId: schema.rikaHostedExecutorAssignments.executorInstanceId,
      processIncarnation: schema.rikaHostedExecutorAssignments.processIncarnation,
      sessionDigest: schema.rikaHostedExecutorAssignments.sessionDigest,
      leaseEpoch: schema.rikaHostedExecutorAssignments.leaseEpoch,
      leaseExpiresAt: schema.rikaHostedExecutorAssignments.leaseExpiresAt,
      updatedAt: schema.rikaHostedExecutorAssignments.updatedAt,
    })
    .from(schema.rikaHostedExecutorAssignments)
    .where(sql`${schema.rikaHostedExecutorAssignments.id} = ${assignmentId}`)
    .pipe(Effect.map((rows) => rows[0]!))

export const readBindings = (database: PgDrizzle.EffectPgDatabase, assignmentId: string) =>
  database
    .select()
    .from(rikaBoxAssignmentBindings)
    .where(sql`${rikaBoxAssignmentBindings.assignmentId} = ${assignmentId}`)
    .orderBy(rikaBoxAssignmentBindings.generation)

export { rikaBoxAssignmentBindings }
