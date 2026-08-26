import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import { BetterAuthUserId, OrganizationId, type HostedOwner, type JsonObject } from "@rika/product/hosted-model"
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer, Schema } from "effect"
import {
  rikaHostedExecutorAssignments,
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedProjectGrants,
  rikaHostedProjects,
  rikaHostedRunnerRegistrations,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "../../database/schema/product"

export class ProductRepositoryError extends Schema.TaggedError<ProductRepositoryError>()("ProductRepositoryError", {
  kind: Schema.Literals(["conflict", "forbidden", "not-found", "unavailable"]),
  message: Schema.String,
}) {}

export interface OwnerAuthority {
  readonly ownerId: string
  readonly owner: HostedOwner
  readonly userId: string
  readonly membershipId?: string
}

export interface ProductProject {
  readonly id: string
  readonly ownerId: string
  readonly owner: HostedOwner
  readonly name: string
  readonly role: "viewer" | "controller" | "operator" | "owner"
}

export interface ProjectAccess {
  readonly role: ProductProject["role"]
}

export interface ThreadAuthorityProjection {
  readonly ownerId: string
  readonly kind: string
  readonly userId: string | null
  readonly organizationId: string | null
  readonly membershipId: string | null
  readonly createdByUserId: string
  readonly executorKind: "runner" | "orb"
  readonly inheritProjectGrants: boolean
  readonly threadRole: ProductProject["role"] | null
  readonly projectRole: ProductProject["role"] | null
}

export interface ThreadExecutionProjection {
  readonly assignmentId: string
  readonly executorKind: "runner" | "orb"
  readonly generation: string
  readonly lifecycle: string
  readonly executorInstanceId: string | null
  readonly providerInstanceId: string | null
  readonly checkout: unknown | null
  readonly localRepository: unknown | null
}

export type CreateConnectionResult =
  | { readonly _tag: "Created"; readonly threadId: string }
  | { readonly _tag: "Existing"; readonly threadId: string }
  | { readonly _tag: "Incompatible" }
  | { readonly _tag: "RunnerMissing" }
  | { readonly _tag: "RunnerAuthorityMismatch" }
  | { readonly _tag: "RunnerRemoteDenied" }

const RunnerPlacement = Schema.TaggedStruct("RunnerPlacement", {
  deviceId: Schema.String,
  checkoutFingerprint: Schema.String,
  requestingDeviceId: Schema.String,
})

export interface ProductRepositoryService {
  readonly resolveOwner: (input: {
    readonly userId: string
    readonly selection: HostedOwner
    readonly proposedOwnerId: string
    readonly now: Date
  }) => Effect.Effect<OwnerAuthority, ProductRepositoryError>
  readonly organizationIds: (userId: string) => Effect.Effect<ReadonlyArray<string>, ProductRepositoryError>
  readonly projects: (input: {
    readonly userId: string
    readonly personalOwnerId: string
  }) => Effect.Effect<ReadonlyArray<ProductProject>, ProductRepositoryError>
  readonly projectAccess: (input: {
    readonly authority: OwnerAuthority
    readonly projectId: string
  }) => Effect.Effect<ProjectAccess | undefined, ProductRepositoryError>
  readonly createProject: (input: {
    readonly id: string
    readonly authority: OwnerAuthority
    readonly name: string
    readonly now: Date
  }) => Effect.Effect<ProductProject, ProductRepositoryError>
  readonly existingConnection: (input: {
    readonly authority: OwnerAuthority
    readonly projectId: string | null
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: { readonly deviceId: string; readonly checkoutFingerprint: string }
    readonly threadId: string
  }) => Effect.Effect<
    Extract<CreateConnectionResult, { readonly _tag: "Existing" | "Incompatible" }> | undefined,
    ProductRepositoryError
  >
  readonly createConnection: (input: {
    readonly authority: OwnerAuthority
    readonly projectId: string | null
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: { readonly deviceId: string; readonly checkoutFingerprint: string }
    readonly requestingDeviceId: string
    readonly threadId: string
    readonly workspaceId: string
    readonly assignmentId: string
    readonly placement: JsonObject
    readonly checkout: JsonObject | null
    readonly now: Date
    readonly nowMillis: number
  }) => Effect.Effect<CreateConnectionResult, ProductRepositoryError>
  readonly threadAuthority: (
    userId: string,
    threadId: string,
  ) => Effect.Effect<ThreadAuthorityProjection | undefined, ProductRepositoryError>
  readonly threadExecutionContext: (
    ownerId: string,
    threadId: string,
  ) => Effect.Effect<ThreadExecutionProjection | undefined, ProductRepositoryError>
  readonly ready: Effect.Effect<void, ProductRepositoryError>
}

export class ProductRepository extends Context.Service<ProductRepository, ProductRepositoryService>()(
  "@rika/product-store/hosted/product/repository/ProductRepository",
) {}

const databaseError = (cause: unknown) => ProductRepositoryError.make({ kind: "unavailable", message: String(cause) })
const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(databaseError))

const make = Effect.gen(function* () {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const resolveOwner: ProductRepositoryService["resolveOwner"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          let membershipId: string | undefined
          if (input.selection._tag === "PersonalOwner") {
            if (input.selection.userId !== input.userId)
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" })
            const identity = yield* query(
              tx
                .select({ id: identityUser.id })
                .from(identityUser)
                .where(eq(identityUser.id, input.userId))
                .for("update")
                .limit(1),
            )
            if (identity[0] === undefined)
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" })
          } else {
            const membership = yield* query(
              tx
                .select({ membershipId: identityMember.id })
                .from(identityOrganization)
                .innerJoin(
                  identityMember,
                  and(
                    eq(identityMember.organizationId, identityOrganization.id),
                    eq(identityMember.userId, input.userId),
                  ),
                )
                .where(eq(identityOrganization.id, input.selection.organizationId))
                .for("update", { of: identityOrganization })
                .limit(1),
            )
            if (membership[0] === undefined)
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" })
            membershipId = membership[0].membershipId
          }
          const ownerCondition =
            input.selection._tag === "PersonalOwner"
              ? eq(rikaHostedOwners.userId, input.userId)
              : eq(rikaHostedOwners.organizationId, input.selection.organizationId)
          const existing = yield* query(
            tx.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).where(ownerCondition).limit(1),
          )
          const ownerId = existing[0]?.id ?? input.proposedOwnerId
          if (existing[0] === undefined) {
            yield* query(
              tx
                .insert(rikaHostedOwners)
                .values({
                  id: ownerId,
                  kind: input.selection._tag === "PersonalOwner" ? "personal" : "organization",
                  userId: input.selection._tag === "PersonalOwner" ? input.userId : null,
                  organizationId: input.selection._tag === "OrganizationOwner" ? input.selection.organizationId : null,
                  createdAt: input.now,
                })
                .onConflictDoNothing()
                .returning({ id: rikaHostedOwners.id }),
            )
            yield* query(
              tx
                .insert(rikaHostedOwnerCounters)
                .values({ ownerId })
                .onConflictDoNothing()
                .returning({ ownerId: rikaHostedOwnerCounters.ownerId }),
            )
            const concurrent = yield* query(
              tx.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).where(ownerCondition).limit(1),
            )
            const resolvedId = concurrent[0]?.id
            if (resolvedId === undefined) return yield* databaseError("Owner was not persisted")
            return membershipId === undefined
              ? { ownerId: resolvedId, owner: input.selection, userId: input.userId }
              : { ownerId: resolvedId, owner: input.selection, userId: input.userId, membershipId }
          }
          return membershipId === undefined
            ? { ownerId, owner: input.selection, userId: input.userId }
            : { ownerId, owner: input.selection, userId: input.userId, membershipId }
        }),
      )
      .pipe(Effect.mapError((error) => (Schema.is(ProductRepositoryError)(error) ? error : databaseError(error))))

  const organizationIds: ProductRepositoryService["organizationIds"] = (userId) =>
    query(
      db
        .select({ id: identityMember.organizationId })
        .from(identityMember)
        .where(eq(identityMember.userId, userId))
        .orderBy(asc(identityMember.organizationId)),
    ).pipe(Effect.map((rows) => rows.map((row) => row.id)))

  const projects: ProductRepositoryService["projects"] = (input) =>
    query(
      db
        .select({
          id: rikaHostedProjects.id,
          ownerId: rikaHostedOwners.id,
          kind: rikaHostedOwners.kind,
          ownerUserId: rikaHostedOwners.userId,
          organizationId: rikaHostedOwners.organizationId,
          name: rikaHostedProjects.name,
          createdByUserId: rikaHostedProjects.createdByUserId,
          grantRole: rikaHostedProjectGrants.role,
        })
        .from(rikaHostedProjects)
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProjects.ownerId))
        .leftJoin(
          identityMember,
          and(
            eq(identityMember.organizationId, rikaHostedOwners.organizationId),
            eq(identityMember.userId, input.userId),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedProjects.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedProjects.id),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(
          or(
            and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.id, input.personalOwnerId)),
            and(
              eq(rikaHostedOwners.kind, "organization"),
              isNotNull(identityMember.id),
              or(eq(rikaHostedProjects.createdByUserId, input.userId), isNotNull(rikaHostedProjectGrants.role)),
            ),
          ),
        )
        .orderBy(asc(rikaHostedProjects.createdAt), asc(rikaHostedProjects.id)),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => {
          let owner: HostedOwner | undefined
          if (row.kind === "personal" && row.ownerUserId !== null)
            owner = { _tag: "PersonalOwner", userId: BetterAuthUserId.make(row.ownerUserId) }
          else if (row.kind === "organization" && row.organizationId !== null)
            owner = { _tag: "OrganizationOwner", organizationId: OrganizationId.make(row.organizationId) }
          const role =
            row.kind === "personal" || row.createdByUserId === input.userId ? ("owner" as const) : row.grantRole
          return owner === undefined || role === null
            ? Effect.fail(databaseError("Invalid project authority projection"))
            : Effect.succeed({ id: row.id, ownerId: row.ownerId, owner, name: row.name, role })
        }),
      ),
    )

  const projectAccess: ProductRepositoryService["projectAccess"] = (input) =>
    query(
      db
        .select({ createdByUserId: rikaHostedProjects.createdByUserId, role: rikaHostedProjectGrants.role })
        .from(rikaHostedProjects)
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedProjects.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedProjects.id),
            input.authority.membershipId === undefined
              ? isNull(rikaHostedProjectGrants.membershipId)
              : eq(rikaHostedProjectGrants.membershipId, input.authority.membershipId),
          ),
        )
        .where(
          and(
            eq(rikaHostedProjects.id, input.projectId),
            eq(rikaHostedProjects.ownerId, input.authority.ownerId),
            or(eq(rikaHostedProjects.createdByUserId, input.authority.userId), isNotNull(rikaHostedProjectGrants.role)),
          ),
        )
        .limit(1),
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        if (row === undefined) return undefined
        if (row.createdByUserId === input.authority.userId) return { role: "owner" as const }
        return { role: row.role ?? "viewer" }
      }),
    )

  const createProject: ProductRepositoryService["createProject"] = (input) =>
    query(
      db
        .insert(rikaHostedProjects)
        .values({
          id: input.id,
          ownerId: input.authority.ownerId,
          name: input.name,
          createdByUserId: input.authority.userId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: rikaHostedProjects.id, ownerId: rikaHostedProjects.ownerId, name: rikaHostedProjects.name }),
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(databaseError("Project was not persisted"))
          : Effect.succeed({ ...rows[0], owner: input.authority.owner, role: "owner" }),
      ),
    )

  const existingConnection: ProductRepositoryService["existingConnection"] = (input) =>
    query(
      db
        .select({
          ownerId: rikaHostedThreads.ownerId,
          projectId: rikaHostedThreads.projectId,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          placement: rikaHostedExecutorAssignments.placement,
        })
        .from(rikaHostedThreads)
        .innerJoin(rikaHostedExecutorAssignments, eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id))
        .where(eq(rikaHostedThreads.id, input.threadId))
        .limit(1),
    ).pipe(
      Effect.map((rows) => {
        const existing = rows[0]
        if (existing === undefined) return undefined
        const placement = Schema.decodeUnknownOption(RunnerPlacement)(existing.placement)
        const runnerCompatible =
          input.runnerTarget === undefined ||
          (placement._tag === "Some" &&
            placement.value.deviceId === input.runnerTarget.deviceId &&
            placement.value.checkoutFingerprint === input.runnerTarget.checkoutFingerprint)
        return existing.ownerId === input.authority.ownerId &&
          existing.projectId === input.projectId &&
          existing.createdByUserId === input.authority.userId &&
          existing.executorKind === input.executorKind &&
          runnerCompatible
          ? { _tag: "Existing" as const, threadId: input.threadId }
          : { _tag: "Incompatible" as const }
      }),
    )

  const createConnection: ProductRepositoryService["createConnection"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.threadId}, 0))`)
            .pipe(Effect.mapError(databaseError))
          let workspaceId = input.workspaceId
          const existing = (yield* query(
            tx
              .select({
                ownerId: rikaHostedThreads.ownerId,
                projectId: rikaHostedThreads.projectId,
                createdByUserId: rikaHostedThreads.createdByUserId,
                executorKind: rikaHostedThreads.executorKind,
                placement: rikaHostedExecutorAssignments.placement,
              })
              .from(rikaHostedThreads)
              .innerJoin(
                rikaHostedExecutorAssignments,
                eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id),
              )
              .where(eq(rikaHostedThreads.id, input.threadId))
              .limit(1),
          ))[0]
          if (existing !== undefined) {
            const placement = Schema.decodeUnknownOption(RunnerPlacement)(existing.placement)
            const runnerCompatible =
              input.runnerTarget === undefined ||
              (placement._tag === "Some" &&
                placement.value.deviceId === input.runnerTarget.deviceId &&
                placement.value.checkoutFingerprint === input.runnerTarget.checkoutFingerprint)
            return existing.ownerId === input.authority.ownerId &&
              existing.projectId === input.projectId &&
              existing.createdByUserId === input.authority.userId &&
              existing.executorKind === input.executorKind &&
              runnerCompatible
              ? { _tag: "Existing" as const, threadId: input.threadId }
              : { _tag: "Incompatible" as const }
          }
          if (input.runnerTarget !== undefined) {
            const runner = (yield* query(
              tx
                .select({
                  workspaceId: rikaHostedRunnerRegistrations.workspaceId,
                  projectId: rikaHostedRunnerRegistrations.projectId,
                  userId: rikaHostedRunnerRegistrations.userId,
                  allowed: rikaHostedRunnerRegistrations.remoteThreadCreationAllowed,
                })
                .from(rikaHostedRunnerRegistrations)
                .where(
                  and(
                    eq(rikaHostedRunnerRegistrations.deviceId, input.runnerTarget.deviceId),
                    eq(rikaHostedRunnerRegistrations.checkoutFingerprint, input.runnerTarget.checkoutFingerprint),
                  ),
                )
                .for("update")
                .limit(1),
            ))[0]
            if (runner === undefined) return { _tag: "RunnerMissing" as const }
            if (runner.userId !== input.authority.userId || runner.projectId !== input.projectId)
              return { _tag: "RunnerAuthorityMismatch" as const }
            if (input.requestingDeviceId !== input.runnerTarget.deviceId && !runner.allowed)
              return { _tag: "RunnerRemoteDenied" as const }
            workspaceId = runner.workspaceId
          }
          const inheritProjectGrants = input.executorKind === "orb" && input.projectId !== null
          yield* query(
            tx
              .insert(rikaHostedWorkspaces)
              .values({
                id: workspaceId,
                ownerId: input.authority.ownerId,
                projectId: input.projectId,
                createdByUserId: input.authority.userId,
                executorKind: input.executorKind,
                inheritProjectGrants,
                createdAt: input.now,
              })
              .onConflictDoNothing()
              .returning({ id: rikaHostedWorkspaces.id }),
          )
          yield* query(
            tx
              .insert(rikaWorkspaces)
              .values({ ownerId: input.authority.ownerId, path: workspaceId, createdAt: input.nowMillis })
              .onConflictDoNothing()
              .returning({ path: rikaWorkspaces.path }),
          )
          yield* query(
            tx
              .insert(rikaHostedThreads)
              .values({
                id: input.threadId,
                ownerId: input.authority.ownerId,
                projectId: input.projectId,
                workspaceId,
                createdByUserId: input.authority.userId,
                executorKind: input.executorKind,
                inheritProjectGrants,
                createdAt: input.now,
              })
              .returning({ id: rikaHostedThreads.id }),
          )
          yield* query(
            tx
              .insert(rikaThreads)
              .values({
                id: input.threadId,
                ownerId: input.authority.ownerId,
                workspace: workspaceId,
                title: "New thread",
                createdAt: input.nowMillis,
                updatedAt: input.nowMillis,
              })
              .returning({ id: rikaThreads.id }),
          )
          if (
            input.authority.owner._tag === "OrganizationOwner" &&
            input.projectId === null &&
            input.authority.membershipId !== undefined
          )
            yield* query(
              tx
                .insert(rikaHostedThreadGrants)
                .values({
                  ownerId: input.authority.ownerId,
                  threadId: input.threadId,
                  membershipId: input.authority.membershipId,
                  role: "owner",
                  grantedByUserId: input.authority.userId,
                  createdAt: input.now,
                  updatedAt: input.now,
                })
                .returning({ threadId: rikaHostedThreadGrants.threadId }),
            )
          yield* query(
            tx
              .insert(rikaHostedExecutorAssignments)
              .values({
                id: input.assignmentId,
                ownerId: input.authority.ownerId,
                threadId: input.threadId,
                workspaceId,
                executorKind: input.executorKind,
                placement: input.placement,
                checkout: input.checkout,
                generation: 1,
                revision: 0,
                lastLeaseEpoch: 0,
                lifecycle: "pending",
              })
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
          return { _tag: "Created" as const, threadId: input.threadId }
        }),
      )
      .pipe(Effect.mapError((error) => (Schema.is(ProductRepositoryError)(error) ? error : databaseError(error))))

  const threadAuthority: ProductRepositoryService["threadAuthority"] = (userId, threadId) =>
    query(
      db
        .select({
          ownerId: rikaHostedThreads.ownerId,
          kind: rikaHostedOwners.kind,
          userId: rikaHostedOwners.userId,
          organizationId: rikaHostedOwners.organizationId,
          membershipId: identityMember.id,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
          threadRole: rikaHostedThreadGrants.role,
          projectRole: rikaHostedProjectGrants.role,
        })
        .from(rikaHostedThreads)
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreads.ownerId))
        .leftJoin(
          identityMember,
          and(eq(identityMember.organizationId, rikaHostedOwners.organizationId), eq(identityMember.userId, userId)),
        )
        .leftJoin(
          rikaHostedThreadGrants,
          and(
            eq(rikaHostedThreadGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedThreadGrants.threadId, rikaHostedThreads.id),
            eq(rikaHostedThreadGrants.membershipId, identityMember.id),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedThreads.projectId),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(eq(rikaHostedThreads.id, threadId))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]))

  const threadExecutionContext: ProductRepositoryService["threadExecutionContext"] = (ownerId, threadId) =>
    Effect.gen(function* () {
      const row = (yield* query(
        db
          .select({
            assignmentId: rikaHostedExecutorAssignments.id,
            executorKind: rikaHostedExecutorAssignments.executorKind,
            generation: rikaHostedExecutorAssignments.generation,
            lifecycle: rikaHostedExecutorAssignments.lifecycle,
            executorInstanceId: rikaHostedExecutorAssignments.executorInstanceId,
            providerInstanceId: rikaHostedExecutorAssignments.providerInstanceId,
            checkout: rikaHostedExecutorAssignments.checkout,
            placement: rikaHostedExecutorAssignments.placement,
          })
          .from(rikaHostedExecutorAssignments)
          .where(
            and(
              eq(rikaHostedExecutorAssignments.ownerId, ownerId),
              eq(rikaHostedExecutorAssignments.threadId, threadId),
            ),
          )
          .limit(1),
      ))[0]
      if (row === undefined) return undefined
      let localRepository: unknown | null = null
      const placement = Schema.decodeUnknownOption(RunnerPlacement)(row.placement)
      if (row.executorKind === "runner" && placement._tag === "Some") {
        const registrations = yield* query(
          db
            .select({ repository: rikaHostedRunnerRegistrations.repository })
            .from(rikaHostedRunnerRegistrations)
            .where(
              and(
                eq(rikaHostedRunnerRegistrations.deviceId, placement.value.deviceId),
                eq(rikaHostedRunnerRegistrations.checkoutFingerprint, placement.value.checkoutFingerprint),
              ),
            )
            .limit(1),
        )
        localRepository = registrations[0]?.repository ?? null
      }
      return {
        assignmentId: row.assignmentId,
        executorKind: row.executorKind,
        generation: String(row.generation),
        lifecycle: row.lifecycle,
        executorInstanceId: row.executorInstanceId,
        providerInstanceId: row.providerInstanceId,
        checkout: row.checkout,
        localRepository,
      }
    })

  return ProductRepository.of({
    resolveOwner,
    organizationIds,
    projects,
    projectAccess,
    createProject,
    existingConnection,
    createConnection,
    threadAuthority,
    threadExecutionContext,
    ready: query(db.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).limit(1)).pipe(Effect.asVoid),
  })
})

export const layer = Layer.effect(ProductRepository, make)
