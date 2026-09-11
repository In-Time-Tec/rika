import { expect, it } from "@effect/vitest"
import { identityMember, identityOrganization } from "@rika/identity"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { and, eq, sql as drizzleSql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { DateTime, Effect, Layer, Redacted } from "effect"
import { clientLayer } from "../../../src/database/postgres"
import * as schema from "../../../src/database/schema/product"
import type { OwnerAuthority, ProductRepositoryService } from "../../../src/hosted/product/contract"
import { threadOperations } from "../../../src/hosted/product/thread-operations"
import { workspaceOperations } from "../../../src/hosted/product/workspace-operations"
import { identityMigrations } from "../../../../identity/src/database/migrations"
import { migrations } from "../../../src/hosted/migrations"
import { apply, isolated, live, seedIdentity } from "../assignments.support"

const userId = BetterAuthUserId.make("user-recovery")
const personal: OwnerAuthority = {
  ownerId: "seed-personal-owner",
  owner: { _tag: "PersonalOwner", userId },
  userId,
}
const organizationA: OwnerAuthority = {
  ownerId: "seed-organization-owner-a",
  owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make("organization-recovery") },
  userId,
  membershipId: "member-recovery",
}
const organizationB: OwnerAuthority = {
  ownerId: "seed-organization-owner-b",
  owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make("organization-other") },
  userId,
  membershipId: "member-other",
}
const now = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))
const expiresAt = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:01:00.000Z"))
const placement = {
  _tag: "OrbPlacement",
  templateBuildId: "seed-template",
  providerScope: "seed-provider",
  executorPolicy: { buildId: "seed-executor", protocolVersion: 1 },
  lineageId: "seed-lineage",
}

const manifest = (id: string) => ({
  id,
  sourceRepository: null,
  objectKey: `workspace-seeds/${id}.tar.zst`,
  contentDigest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 1024,
  archiveDigest: `sha256:${"b".repeat(64)}`,
  archiveSizeBytes: 768,
  encryption: "aes-256-gcm" as const,
})

type SeedRepository = Pick<ProductRepositoryService, "stageWorkspaceSeed" | "createConnection">

const stage = (repository: SeedRepository, ownerId: string, id: string) =>
  repository.stageWorkspaceSeed({
    id,
    ownerId,
    userId,
    deviceId: "seed-device",
    clientId: "seed-client",
    manifest: manifest(id),
    expiresAt,
    now,
  })

const claim = (repository: SeedRepository, authority: OwnerAuthority, suffix: string, workspaceSeedId: string) =>
  repository.createConnection({
    authority,
    projectId: null,
    executorKind: "orb",
    requestingDeviceId: "seed-device",
    requestingClientId: "seed-client",
    workspaceSeedId,
    threadId: `seed-thread-${suffix}`,
    workspaceId: `seed-workspace-${suffix}`,
    assignmentId: `seed-assignment-${suffix}`,
    placement,
    checkout: null,
    now,
    nowMillis: 1,
  })

const fixture = <A, E>(
  run: (input: {
    readonly repository: SeedRepository
    readonly database: PgDrizzle.EffectPgDatabase
  }) => Effect.Effect<A, E>,
) =>
  isolated(({ url, pool, database, effectDatabase }) =>
    Effect.gen(function* () {
      yield* apply(pool, [...identityMigrations, ...migrations])
      yield* seedIdentity(database)
      const createdAt = drizzleSql`transaction_timestamp()`
      yield* Effect.tryPromise(() =>
        database.insert(identityOrganization).values({
          id: "organization-other",
          name: "Other Organization",
          slug: "other-organization",
          createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values({
          id: "member-other",
          organizationId: "organization-other",
          userId,
          role: "owner",
          createdAt,
        }),
      )
      yield* effectDatabase.insert(schema.rikaHostedOwners).values([
        { id: personal.ownerId, kind: "personal", userId },
        { id: organizationA.ownerId, kind: "organization", organizationId: organizationA.owner.organizationId },
        { id: organizationB.ownerId, kind: "organization", organizationId: organizationB.owner.organizationId },
      ])
      const context = yield* Layer.build(clientLayer({ url: Redacted.make(url), maxConnections: 4 }))
      const workspace = yield* workspaceOperations.pipe(Effect.provideContext(context))
      const thread = yield* threadOperations.pipe(Effect.provideContext(context))
      return yield* run({ repository: { ...workspace, ...thread }, database: effectDatabase })
    }),
  )

const storedSeed = (database: PgDrizzle.EffectPgDatabase, id: string) =>
  database
    .select({
      ownerId: schema.rikaHostedWorkspaceSeeds.ownerId,
      claimedAssignmentId: schema.rikaHostedWorkspaceSeeds.claimedAssignmentId,
    })
    .from(schema.rikaHostedWorkspaceSeeds)
    .where(eq(schema.rikaHostedWorkspaceSeeds.id, id))
    .pipe(Effect.map((rows) => rows[0]))

it.effect.skipIf(!live)("claims staged Workspace seeds only under their exact owner", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      for (const [authority, suffix] of [
        [personal, "personal"],
        [organizationA, "organization"],
      ] as const) {
        const seedId = `seed-correct-${suffix}`
        yield* stage(repository, authority.ownerId, seedId)
        expect(yield* claim(repository, authority, suffix, seedId)).toEqual({
          _tag: "Created",
          threadId: `seed-thread-${suffix}`,
        })
        expect(yield* storedSeed(database, seedId)).toEqual({
          ownerId: authority.ownerId,
          claimedAssignmentId: `seed-assignment-${suffix}`,
        })
        expect(
          (yield* database
            .select({ workspaceSeed: schema.rikaHostedExecutorAssignments.workspaceSeed })
            .from(schema.rikaHostedExecutorAssignments)
            .where(eq(schema.rikaHostedExecutorAssignments.id, `seed-assignment-${suffix}`)))[0]?.workspaceSeed,
        ).toEqual(manifest(seedId))
      }
    }),
  ),
)

it.effect.skipIf(!live)("rejects same-creator claims across personal and organization owners", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const cases = [
        { stagedOwnerId: personal.ownerId, claimant: organizationA, suffix: "personal-to-organization" },
        { stagedOwnerId: organizationA.ownerId, claimant: personal, suffix: "organization-to-personal" },
        { stagedOwnerId: organizationA.ownerId, claimant: organizationB, suffix: "organization-to-other" },
      ] as const
      for (const input of cases) {
        const seedId = `seed-cross-${input.suffix}`
        yield* stage(repository, input.stagedOwnerId, seedId)
        expect(yield* Effect.result(claim(repository, input.claimant, input.suffix, seedId))).toMatchObject({
          _tag: "Failure",
          failure: { kind: "forbidden", message: "Workspace seed is unavailable" },
        })
        expect(yield* storedSeed(database, seedId)).toEqual({
          ownerId: input.stagedOwnerId,
          claimedAssignmentId: null,
        })
        expect(
          yield* database
            .select({ id: schema.rikaHostedExecutorAssignments.id })
            .from(schema.rikaHostedExecutorAssignments)
            .where(
              and(
                eq(schema.rikaHostedExecutorAssignments.id, `seed-assignment-${input.suffix}`),
                eq(schema.rikaHostedExecutorAssignments.ownerId, input.claimant.ownerId),
              ),
            ),
        ).toEqual([])
      }
    }),
  ),
)

it.effect.skipIf(!live)("retains pre-migration Workspace seed rows as ownerless", () =>
  isolated(({ pool, database, effectDatabase }) =>
    Effect.gen(function* () {
      const ownerMigration = migrations.find(({ id }) => id === "product/0046_workspace_seed_owner_authority")
      if (ownerMigration === undefined) return yield* Effect.die("Workspace seed owner migration is missing")
      yield* apply(pool, [...identityMigrations, ...migrations.filter(({ id }) => id !== ownerMigration.id)])
      yield* seedIdentity(database)
      yield* effectDatabase.insert(schema.rikaHostedOwners).values({
        id: personal.ownerId,
        kind: "personal",
        userId,
      })
      const seedId = "seed-before-owner-migration"
      yield* Effect.tryPromise(() =>
        pool.query(
          `insert into rika_hosted_workspace_seeds
            (id, created_by_user_id, created_by_device_id, created_by_client_id, manifest, expires_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [seedId, userId, "seed-device", "seed-client", manifest(seedId), expiresAt, now],
        ),
      )
      yield* apply(pool, [ownerMigration])
      expect(yield* storedSeed(effectDatabase, seedId)).toEqual({ ownerId: null, claimedAssignmentId: null })
    }),
  ),
)

it.effect.skipIf(!live)("retains historical ownerless seeds without allowing them to be claimed", () =>
  fixture(({ repository, database }) =>
    Effect.gen(function* () {
      const seedId = "seed-historical-ownerless"
      yield* database.insert(schema.rikaHostedWorkspaceSeeds).values({
        id: seedId,
        ownerId: null,
        createdByUserId: userId,
        createdByDeviceId: "seed-device",
        createdByClientId: "seed-client",
        manifest: manifest(seedId),
        expiresAt,
        createdAt: now,
      })
      expect(yield* Effect.result(claim(repository, personal, "historical", seedId))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "forbidden", message: "Workspace seed is unavailable" },
      })
      expect(yield* storedSeed(database, seedId)).toEqual({ ownerId: null, claimedAssignmentId: null })
    }),
  ),
)
